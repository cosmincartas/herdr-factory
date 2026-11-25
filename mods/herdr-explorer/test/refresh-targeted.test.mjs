// Refresh lists only what changed (P3b).
//
// watchFolder resolves with the changed absolute paths, but refresh used to ignore them and
// re-list every open folder one at a time, calling `git rev-parse` again on each pass. A batch
// now names what to re-list: only the open folders (and the root) that hold a changed path, all of
// them for a batch holding the root, and nothing for a batch under a closed folder. Marks are
// fetched on every refresh; a full refresh (r, the timer, a new root) starts its listings
// together, at most eight at a time; the git top is remembered per root, and a probe that is
// still pending or was unsuccessful is shared or retried instead of being lost.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { onExec, reset, resolveWatch, state } from "herdr";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";
import { resetUi } from "./stubs/ui.mjs";

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
});

const ROOT = "/repo", OTHER = "/other";
const OPEN = ["a", "b", "c"];

/** `kind\0name\0` per entry, as listing.js's script prints them. */
const listing = entries => entries.map(e => `${e.dir ? "d" : "f"}\0${e.name}\0`).join("");

/** What listFolder answers for each folder the tests open. */
const FOLDERS = {
  [ROOT]: [{ name: "a", dir: true }, { name: "b", dir: true }, { name: "c", dir: true }, { name: "top.js", dir: false }],
  [`${ROOT}/a`]: [{ name: "one.js", dir: false }],
  [`${ROOT}/b`]: [{ name: "two.js", dir: false }],
  [`${ROOT}/c`]: [{ name: "three.js", dir: false }],
  [OTHER]: [{ name: "sub", dir: true }, { name: "other.js", dir: false }],
};

/** `checking()` is on, so init starts no timers and no folder watch: the test drives refresh. */
function seeded(open = OPEN, root = ROOT) {
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = root;
  explorer.gen = 1;
  explorer.open = new Set(open);
  return { explorer, cx };
}

/** Seeded, then watching its root like the live app: batches are delivered through watchRoot. */
async function watching(open = OPEN, root = ROOT) {
  const { explorer, cx } = seeded(open, root);
  state.checking = () => false;   // init already ran; watchRoot is the only thing left to permit
  explorer.watchRoot(cx);
  await flush(5);                 // watchRoot arms the first watch in its task
  return { explorer, cx };
}

/** Routes the commands a refresh runs and records the folders it listed, in call order. */
function routeRefresh({ status = () => ({ code: 0, stdout: "", stderr: "" }), folders = FOLDERS, revParse } = {}) {
  const listed = [], counts = { revParse: 0, status: 0 };
  onExec("sh", (_command, args) => {
    const folder = args[3];
    listed.push(folder);
    return { code: 0, stdout: listing(folders[folder] ?? []), stderr: "" };
  });
  onExec(/rev-parse/, (_command, _args, options) => {
    counts.revParse++;
    return revParse ? revParse(options) : { code: 0, stdout: `${options.cwd}\n`, stderr: "" };
  });
  onExec(/status/, () => { counts.status++; return status(); });
  return { listed, counts };
}

/** A promise a test resolves when it wants a command to answer. */
function pending() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test("a watch batch lists only the open folder that changed", async () => {
  const { explorer, cx } = await watching();
  const { listed } = routeRefresh();
  explorer.refresh(cx);           // the full refresh the root starts with
  await flush(50);
  listed.length = 0;

  assert.ok(resolveWatch(ROOT, [`${ROOT}/a/two.js`]), "the explorer watches its root");
  await flush(50);

  assert.deepEqual(listed, [`${ROOT}/a`], `folders listed after one file in /repo/a changed: ${listed.join(" ")}`);
});

test("a batch naming an open folder lists only its parent", async () => {
  const { explorer, cx } = await watching();
  const { listed } = routeRefresh();
  explorer.refresh(cx);
  await flush(50);
  listed.length = 0;

  assert.ok(resolveWatch(ROOT, [`${ROOT}/a`]), "the explorer watches its root");
  await flush(50);

  assert.deepEqual(listed, [ROOT], `folders listed for the open folder /repo/a itself: ${listed.join(" ")}`);
});

test("an explorer rooted at / names the folder of a changed file", async () => {
  const folders = {
    "/": [{ name: "a", dir: true }, { name: "top.js", dir: false }],
    "/a": [{ name: "file.js", dir: false }],
  };
  const { explorer, cx } = await watching(["a"], "/");
  const { listed } = routeRefresh({ folders });
  explorer.refresh(cx);
  await flush(50);
  listed.length = 0;

  assert.ok(resolveWatch("/", ["/a/file.js"]), "the explorer watches /");
  await flush(50);
  assert.deepEqual(listed, ["/a"], `folders listed for /a/file.js: ${listed.join(" ")}`);
  listed.length = 0;

  assert.ok(resolveWatch("/", ["/top.js"]), "the explorer watches / again");
  await flush(50);
  assert.deepEqual(listed, ["/"], `folders listed for /top.js: ${listed.join(" ")}`);
});

test("a batch under a closed folder lists nothing and still updates marks", async () => {
  let statuses = 0;
  const { explorer, cx } = await watching();
  const { listed, counts } = routeRefresh({
    status: () => ({ code: 0, stdout: statuses++ === 0 ? "" : " M closed/x.js\0", stderr: "" }),
  });
  explorer.refresh(cx);
  await flush(50);
  assert.deepEqual(explorer.marks, {}, "no marks before the change");
  listed.length = 0;
  counts.status = 0;

  assert.ok(resolveWatch(ROOT, [`${ROOT}/closed/x.js`]), "the explorer watches its root");
  await flush(50);

  assert.deepEqual(listed, [], `folders listed for a file in a closed folder: ${listed.join(" ")}`);
  assert.equal(counts.status, 1, "git status ran for the batch");
  assert.deepEqual(explorer.marks, { [`${ROOT}/closed/x.js`]: "M" }, "the batch's marks are shown");
});

test("a batch holding the root lists every open folder", async () => {
  const { explorer, cx } = await watching();
  const { listed } = routeRefresh();
  explorer.refresh(cx);
  await flush(50);
  listed.length = 0;

  assert.ok(resolveWatch(ROOT, [ROOT]), "the explorer watches its root");
  await flush(50);

  const all = [ROOT, ...OPEN.map(rel => `${ROOT}/${rel}`)];
  assert.deepEqual([...listed].sort(), [...all].sort(), `folders listed for a batch holding the root: ${listed.join(" ")}`);
});

test("a batch that arrives during a refresh re-lists only its own folders", async () => {
  const { explorer, cx } = await watching();
  const status = pending();
  const { listed } = routeRefresh({ status: () => status.promise });

  explorer.refresh(cx);
  await flush(50);
  assert.equal(listed.length, 4, "the first refresh listed the root and every open folder");
  listed.length = 0;

  assert.ok(resolveWatch(ROOT, [`${ROOT}/a/two.js`]), "the explorer watches its root");  // queues
  await flush(50);
  assert.ok(resolveWatch(ROOT, [`${ROOT}/b/three.js`]), "the watch re-armed while the refresh waited");  // merges
  await flush(50);
  assert.deepEqual(listed, [], "no folder is listed while the first refresh waits");

  status.resolve({ code: 0, stdout: "", stderr: "" });
  await flush(50);

  assert.deepEqual([...listed].sort(), [`${ROOT}/a`, `${ROOT}/b`],
    `folders listed by the queued refresh: ${listed.join(" ")}`);
});

test("a queued full refresh re-lists every folder even after a targeted batch", async () => {
  const { explorer, cx } = await watching();
  const status = pending();
  const { listed } = routeRefresh({ status: () => status.promise });
  explorer.refresh(cx);
  await flush(50);
  listed.length = 0;

  assert.ok(resolveWatch(ROOT, [`${ROOT}/a/two.js`]), "the explorer watches its root");  // queues
  await flush(50);
  explorer.refresh(cx);           // a key press or the timer while the first refresh waits
  await flush(50);

  status.resolve({ code: 0, stdout: "", stderr: "" });
  await flush(50);

  const all = [ROOT, ...OPEN.map(rel => `${ROOT}/${rel}`)];
  assert.deepEqual([...listed].sort(), [...all].sort(), `folders listed by the queued full refresh: ${listed.join(" ")}`);
});

test("a full refresh starts its listings together, at most eight at a time", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
  const { explorer, cx } = seeded(many);
  const started = [], waiting = [];
  let active = 0, peak = 0;
  onExec("sh", async (_command, args) => {
    started.push(args[3]);
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => waiting.push(resolve));
    active--;
    return { code: 0, stdout: listing([]), stderr: "" };
  });
  onExec(/rev-parse/, () => ({ code: 0, stdout: `${ROOT}\n`, stderr: "" }));
  onExec(/status/, () => ({ code: 0, stdout: "", stderr: "" }));
  const all = [ROOT, ...many.map(rel => `${ROOT}/${rel}`)];

  explorer.refresh(cx);
  await flush(50);
  assert.ok(started.length > 1, `folders listed together before any answered: ${started.length}`);
  assert.ok(peak <= 8, `folders listed at once, peak: ${peak}`);

  for (let round = 0; started.length < all.length; round++) {
    assert.ok(round < all.length, `no progress with ${started.length} of ${all.length} folders listed`);
    assert.ok(waiting.length > 0, `no listing in flight with ${started.length} of ${all.length} folders listed`);
    for (const resolve of waiting.splice(0)) resolve();
    await flush(50);
    assert.ok(peak <= 8, `folders listed at once, peak over the whole pass: ${peak}`);
  }
  assert.deepEqual([...started].sort(), [...all].sort(), "every open folder listed by a full refresh");
});

test("a failed root listing finishes its folders before the queued refresh starts", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
  const { explorer, cx } = seeded(many);
  const started = [], waiting = [];
  const rootFailed = pending();
  let active = 0, peak = 0, rootCalls = 0;
  onExec("sh", async (_command, args) => {
    const folder = args[3];
    started.push(folder);
    if (folder === ROOT && rootCalls++ === 0) {
      await rootFailed.promise;
      return { code: 1, stdout: "", stderr: "Cannot list /repo" };
    }
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => waiting.push(resolve));
    active--;
    return { code: 0, stdout: listing([]), stderr: "" };
  });
  onExec(/rev-parse/, () => ({ code: 0, stdout: `${ROOT}\n`, stderr: "" }));
  onExec(/status/, () => ({ code: 0, stdout: "", stderr: "" }));
  const all = [ROOT, ...many.map(rel => `${ROOT}/${rel}`)];

  explorer.refresh(cx);
  await flush(50);
  const pool = started.length;
  assert.ok(pool > 1, `folders listed together by the first pass: ${pool}`);
  assert.ok(peak <= 8, `folders listed at once by the first pass, peak: ${peak}`);
  explorer.refresh(cx);           // queued: the first pass still runs
  await flush(50);

  rootFailed.resolve();
  await flush(50);
  assert.equal(started.length, pool,
    `folders listed while the first pass's ${pool - 1} folders are still pending: ${started.join(" ")}`);

  for (let round = 0; explorer.error !== null || started.length < pool + all.length; round++) {
    assert.ok(round < 32, `no progress with ${started.length} listings started and ${new Set(started).size} folders`);
    assert.ok(waiting.length > 0, `no listing in flight with ${started.length} listings started`);
    for (const resolve of waiting.splice(0)) resolve();
    await flush(50);
    assert.ok(peak <= 8, `folders listed at once after the failed pass, peak: ${peak}`);
  }

  assert.deepEqual([...new Set(started)].sort(), [...all].sort(), "every folder listed after the failed pass");
  assert.equal(rootCalls, 2, "the queued refresh listed the root again");
  assert.equal(explorer.error, null, "the follow-up refresh cleared the error");
});

test("an old pass stops listing when the root changes", async () => {
  const many = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
  const { explorer, cx } = seeded(many);
  const started = [], waiting = [];
  onExec("sh", async (_command, args) => {
    started.push(args[3]);
    await new Promise(resolve => waiting.push(resolve));
    return { code: 0, stdout: listing([]), stderr: "" };
  });
  onExec(/rev-parse/, (_command, _args, options) => ({ code: 0, stdout: `${options.cwd}\n`, stderr: "" }));
  onExec(/status/, () => ({ code: 0, stdout: "", stderr: "" }));

  explorer.refresh(cx);
  await flush(50);
  const pool = started.length;
  assert.ok(pool > 1, `folders listed together by the first pass: ${pool}`);

  explorer.setRoot(OTHER, null, cx);
  await flush(50);
  assert.ok(started.includes(OTHER), "the new root was listed");

  for (const resolve of waiting.splice(0)) resolve();   // the old pass's folders answer
  await flush(50);

  const stale = started.filter(path => path.startsWith(`${ROOT}/`));
  assert.equal(stale.length, pool - 1, `folders of the old root listed after the switch: ${stale.join(" ")}`);
});

test("an unsuccessful git rev-parse is tried again on the next refresh", async () => {
  const { explorer, cx } = seeded();
  let probes = 0;
  const { counts } = routeRefresh({
    status: () => ({ code: 0, stdout: " M a/one.js\0", stderr: "" }),
    revParse: options => (++probes === 1
      ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
      : { code: 0, stdout: `${options.cwd}\n`, stderr: "" }),
  });

  explorer.refresh(cx);
  await flush(50);
  assert.equal(counts.revParse, 1, "the first refresh probed the checkout");
  assert.equal(counts.status, 0, "no git status without a checkout");
  assert.deepEqual(explorer.marks, {}, "no marks without a checkout");

  explorer.refresh(cx);
  await flush(50);

  assert.equal(counts.revParse, 2, "git rev-parse calls after a failed probe");
  assert.equal(counts.status, 1, "git status ran once discovery worked");
  assert.deepEqual(explorer.marks, { [`${ROOT}/a/one.js`]: "M" }, "marks of the discovered checkout");
});

test("a git probe still pending is shared when the root comes back", async () => {
  const { explorer, cx } = seeded();
  const probe = pending();
  const probes = new Map();
  let statuses = 0;
  onExec("sh", (_command, args) => ({ code: 0, stdout: listing(FOLDERS[args[3]] ?? []), stderr: "" }));
  onExec(/rev-parse/, (_command, _args, options) => {
    probes.set(options.cwd, (probes.get(options.cwd) ?? 0) + 1);
    return options.cwd === ROOT ? probe.promise : { code: 0, stdout: `${options.cwd}\n`, stderr: "" };
  });
  onExec(/status/, () => { statuses++; return { code: 0, stdout: " M a/one.js\0", stderr: "" }; });

  explorer.refresh(cx);           // the first root's rev-parse stays pending
  await flush(50);
  assert.equal(probes.get(ROOT), 1, "the first root probed once");

  explorer.setRoot(OTHER, null, cx);   // switch away while that probe is pending
  await flush(50);
  explorer.setRoot(ROOT, null, cx);    // and back before it settles
  await flush(50);

  assert.equal(probes.get(ROOT), 1, "git rev-parse calls for a root whose probe is still pending");

  probe.resolve({ code: 0, stdout: `${ROOT}\n`, stderr: "" });
  await flush(50);

  assert.equal(statuses >= 2, true, `git status calls for the other root and the returning one: ${statuses}`);
  assert.deepEqual(explorer.marks, { [`${ROOT}/a/one.js`]: "M" }, "the returning refresh showed its marks");
});

test("git rev-parse runs once per root, git status on every refresh", async () => {
  const { explorer, cx } = seeded();
  const { counts } = routeRefresh();

  explorer.refresh(cx);
  await flush(50);
  explorer.refresh(cx, [`${ROOT}/a/two.js`]);
  await flush(50);
  explorer.refresh(cx);
  await flush(50);
  explorer.refresh(cx);
  await flush(50);

  assert.equal(counts.revParse, 1, "git rev-parse calls for one root over four refreshes");
  assert.equal(counts.status, 4, "git status calls, one per refresh");
});
