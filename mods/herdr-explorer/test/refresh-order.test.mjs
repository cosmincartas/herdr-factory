// The tree shows before git answers (P3a).
//
// A refresh used to be one task: list every open folder, git rev-parse, git status, and only then
// commit the entries, the marks and a single cx.notify(). While git status was pending the panel
// showed nothing. The listings must land as soon as they are in, with their own notify; the marks
// follow in a second commit, still guarded by `gen` so a root switch discards the old result.
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

const ROOT = "/repo", OTHER = "/other";

/** `kind\0name\0` per entry, as listing.js's script prints them. */
const listing = entries => entries.map(e => `${e.dir ? "d" : "f"}\0${e.name}\0`).join("");

const LISTINGS = {
  [ROOT]: [{ name: "src", dir: true }, { name: "a.js", dir: false }],
  [`${ROOT}/src`]: [{ name: "main.js", dir: false }],
  [OTHER]: [{ name: "sub", dir: true }, { name: "b.js", dir: false }],
};

/** Routes the three host commands refresh runs; `status` answers git status. */
function routeCommands(status) {
  onExec("sh", (_command, args) => ({ code: 0, stdout: listing(LISTINGS[args[3]] ?? []), stderr: "" }));
  onExec(/rev-parse/, (_command, _args, options) => ({ code: 0, stdout: `${options.cwd}\n`, stderr: "" }));
  onExec(/status/, status);
}

/** A promise a test resolves when it wants git status to answer. */
function pending() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function seededExplorer(root = ROOT) {
  state.checking = () => true;  // no timers and no folder watch: the test drives refresh itself
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = root;
  explorer.gen = 1;
  explorer.open = new Set(["src"]);
  return { explorer, cx };
}

test("the tree shows before git status answers", async () => {
  const { explorer, cx } = seededExplorer();
  const status = pending();
  routeCommands(() => status.promise);

  const notified = cx.notifications;
  explorer.refresh(cx);
  await flush(50);

  // The listing commit: rows are there and the panel was told to render while git status hangs.
  assert.deepEqual(explorer.rows().map(r => r.path), ["src", "src/main.js", "a.js"],
    "rows before git status returned");
  assert.ok(cx.notifications > notified, "cx.notify fired before git status returned");
  assert.deepEqual(explorer.marks, {}, "no marks before git status returned");

  // The marks commit: a second notify once git status answers.
  const afterListing = cx.notifications;
  status.resolve({ code: 0, stdout: " M src/a.js\0", stderr: "" });
  await flush(50);

  assert.deepEqual(explorer.marks, { [`${ROOT}/src/a.js`]: "M" }, "marks after git status returned");
  assert.deepEqual([...explorer.dirty], [`${ROOT}/src`], "dirty folders after git status returned");
  assert.ok(cx.notifications > afterListing, "cx.notify fired again for the marks");
  assert.equal(explorer.loading, false, "the refresh is finished");
});

test("a root switch during the wait still discards the old result", async () => {
  const { explorer, cx } = seededExplorer();
  const stale = pending();
  let statusCalls = 0;
  routeCommands(() => {
    statusCalls++;
    return statusCalls === 1 ? stale.promise : { code: 0, stdout: " M sub/b.js\0", stderr: "" };
  });

  explorer.refresh(cx);
  await flush(50);             // listings of ROOT are in, git status of ROOT still hangs
  explorer.setRoot(OTHER, null, cx);
  await flush(50);             // the new root's refresh has answered git status already

  assert.deepEqual(explorer.rows().map(r => r.path), ["sub", "b.js"], "the new root's rows");
  assert.deepEqual(explorer.marks, { [`${OTHER}/sub/b.js`]: "M" }, "the new root's marks");

  // The old refresh answers last; its listings and marks belong to the root that went away.
  stale.resolve({ code: 0, stdout: " M src/a.js\0", stderr: "" });
  await flush(50);

  assert.deepEqual(explorer.rows().map(r => r.path), ["sub", "b.js"], "stale listings discarded");
  assert.deepEqual(explorer.marks, { [`${OTHER}/sub/b.js`]: "M" }, "stale marks discarded");
  assert.deepEqual([...explorer.dirty], [`${OTHER}/sub`], "stale dirty folders discarded");
});
