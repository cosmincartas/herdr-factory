// C-12: reveal starts the root and every missing ancestor listing together (P9).
//
// Reveal used to await one folder listing before starting the next: the root, then a, then a/b,
// then a/b/c. On a remote space that is one round trip each. They are now started together with
// the refresh helper's pool, and the cursor and scroll land after they all arrive.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { onExec, reset, state } from "herdr";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";
import { resetUi } from "./stubs/ui.mjs";

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
});

const ROOT = "/repo";

/** `kind\0name\0` per entry, as listing.js's script prints them. */
const listing = entries => entries.map(e => `${e.dir ? "d" : "f"}\0${e.name}\0`).join("");

/** What listFolder answers for each folder on the way to the revealed file. */
const FOLDERS = {
  [ROOT]: [{ name: "a", dir: true }],
  [`${ROOT}/a`]: [{ name: "b", dir: true }],
  [`${ROOT}/a/b`]: [{ name: "c", dir: true }],
  [`${ROOT}/a/b/c`]: [{ name: "d.js", dir: false }],
};

/** An Explorer rooted at /repo that has a reveal request waiting for /repo/a/b/c/d.js. */
function seeded() {
  state.checking = () => true;   // init starts no timers and no folder watch
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = ROOT;
  explorer.gen = 1;
  explorer.runtime = "/run/herdr-explorer";
  const request = `term1\t${ROOT}/a/b/c/d.js\n`;
  state.readTextFile = path => (String(path).endsWith("/reveal") ? request : null);
  return { explorer, cx };
}

test("reveal starts the root and every missing ancestor together, then scrolls to the file", async () => {
  const { explorer, cx } = seeded();
  const started = [], waiting = [];
  onExec("sh", (_command, args) => {
    started.push(args[3]);
    return new Promise(resolve => waiting.push(() => resolve({
      code: 0, stdout: listing(FOLDERS[args[3]] ?? []), stderr: "",
    })));
  });

  const revealing = explorer.reveal(cx);
  await flush(20);

  const ancestors = [ROOT, `${ROOT}/a`, `${ROOT}/a/b`, `${ROOT}/a/b/c`];
  assert.equal(started.length, ancestors.length,
    `ancestor listings in flight after reveal started: ${started.join(" ")}`);
  assert.deepEqual([...started].sort(), [...ancestors].sort(),
    `ancestor listings in flight after reveal started: ${started.join(" ")}`);

  for (const answer of waiting.splice(0)) answer();
  await revealing;
  await flush(20);

  assert.deepEqual([...explorer.open].sort(), ["a", "a/b", "a/b/c"], "reveal opens every ancestor");
  assert.equal(explorer.cursor, "a/b/c/d.js", "reveal selects the revealed file");
  const at = explorer.rows().findIndex(r => r.path === "a/b/c/d.js");
  assert.ok(at >= 0, "the revealed file has a row");
  assert.equal(explorer.scroll.calls.filter(c => c.name === "scroll_to_item").at(-1)?.args[0], at,
    "reveal scrolls to the revealed row");
});

test("reveal shows why an ancestor above the file could not be listed", async () => {
  const { explorer, cx } = seeded();
  const GONE = `${ROOT}/a/b/c`;
  onExec("sh", (_command, args) => {
    const folder = args[3];
    if (folder === GONE) return { code: 1, stdout: "", stderr: `Cannot list ${folder}` };
    return { code: 0, stdout: listing(FOLDERS[folder] ?? []), stderr: "" };
  });

  await explorer.reveal(cx);

  assert.equal(explorer.error, `Cannot list ${GONE}`,
    "the failed ancestor listing explains itself instead of vanishing");
  assert.equal(explorer.listNote("tree"), `Cannot list ${GONE}`, "the tree note shows the failure");
});

test("reveal keeps the ancestors that listed when its own root listing fails", async () => {
  const { explorer, cx } = seeded();
  const started = [], waiting = [];
  onExec("sh", (_command, args) => {
    const folder = args[3];
    started.push(folder);
    return new Promise(resolve => waiting.push({ folder, resolve }));
  });
  onExec(/rev-parse/, () => ({ code: 0, stdout: `${ROOT}\n`, stderr: "" }));
  onExec(/status/, () => ({ code: 0, stdout: "", stderr: "" }));

  // A refresh is listing the root when the reveal starts, so the reveal wants the root too.
  explorer.refresh(cx);
  await flush(5);
  const revealing = explorer.reveal(cx);
  await flush(20);

  const roots = waiting.filter(w => w.folder === ROOT);
  assert.equal(roots.length, 2, `root listings started: ${started.join(" ")}`);
  roots[0].resolve({ code: 0, stdout: listing(FOLDERS[ROOT]), stderr: "" });  // the refresh's
  roots[1].resolve({ code: 1, stdout: "", stderr: `Cannot list ${ROOT}` });    // the reveal's
  for (const w of waiting.filter(w => w.folder !== ROOT)) {
    w.resolve({ code: 0, stdout: listing(FOLDERS[w.folder] ?? []), stderr: "" });
  }
  await revealing;
  await flush(20);

  // The refresh has the root, so the reveal's own root failure must not lose what it listed.
  assert.deepEqual([...explorer.open].sort(), ["a", "a/b", "a/b/c"], "reveal opens every ancestor");
  for (const dir of ["a", "a/b", "a/b/c"]) {
    assert.ok(explorer.entries.has(dir), `the successful listing of ${dir} is kept`);
  }
  assert.equal(explorer.cursor, "a/b/c/d.js", "reveal selects the revealed file");
  const at = explorer.rows().findIndex(r => r.path === "a/b/c/d.js");
  assert.ok(at >= 0, "the revealed file has a row");
  assert.equal(explorer.scroll.calls.filter(c => c.name === "scroll_to_item").at(-1)?.args[0], at,
    "reveal scrolls to the revealed row");
});


test("reveal lists every ancestor past the first eight even when its own root listing fails", async () => {
  const { explorer, cx } = seeded();
  const parts = ["a", "b", "c", "d", "e", "f", "g", "h"];  // eight folders, plus the root: nine listings
  const deep = `${ROOT}/${parts.join("/")}/file.js`;
  state.readTextFile = path => (String(path).endsWith("/reveal") ? `term1\t${deep}\n` : null);
  const child = folder => {
    const depth = folder === ROOT ? 0 : folder.slice(ROOT.length + 1).split("/").length;
    return depth < parts.length ? [{ name: parts[depth], dir: true }] : [{ name: "file.js", dir: false }];
  };
  const started = [], waiting = [];
  onExec("sh", (_command, args) => {
    started.push(args[3]);
    return new Promise(resolve => waiting.push({ folder: args[3], resolve }));
  });
  onExec(/rev-parse/, () => ({ code: 0, stdout: `${ROOT}\n`, stderr: "" }));
  onExec(/status/, () => ({ code: 0, stdout: "", stderr: "" }));

  const revealing = explorer.reveal(cx);
  await flush(20);
  assert.equal(started.length, 8, "eight listings run at once");
  // The root fails first, while seven ancestors are still listing and one is queued.
  waiting.splice(waiting.findIndex(w => w.folder === ROOT), 1)[0]
    .resolve({ code: 1, stdout: "", stderr: `Cannot list ${ROOT}` });
  await flush(20);
  while (waiting.length) {
    const w = waiting.shift();
    w.resolve({ code: 0, stdout: listing(child(w.folder)), stderr: "" });
    await flush(20);
  }
  await revealing;

  const last = `${ROOT}/${parts.join("/")}`;
  assert.ok(started.includes(last), `the queued ancestor is listed after the root failed: ${started.join(" ")}`);
  assert.ok(explorer.entries.has(parts.join("/")), "the deepest ancestor's listing is kept");
});
