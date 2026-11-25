// C-5b: the tree and Find files rows are a virtual list (P2, P6).
//
// Both lists used to build one element per row in render(), so a 5,000-row tree cost the whole
// render budget. They are now `v_virtual_list`s: the host asks the renderer for the visible range
// only, clicks arrive once per list through `on_item_click` with the row's key, and the scroll
// handle is a `VirtualListScrollHandle` so `j`, `k`, `gg`, `ge`, reveal and `gw` keep working.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { onExec, reset, state } from "herdr";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";
import { callsNamed, resetUi, VirtualListScrollHandle } from "./stubs/ui.mjs";

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
});

const ROW_H = 24;

/** `n` flat files, named so their order reads off the name. */
const flat = n => Array.from({ length: n }, (_, i) => ({ name: `file-${String(i).padStart(4, "0")}.js`, dir: false }));

/** A seeded Explorer: checking() stops init before the timers and the folder watch start. */
function seededExplorer({ entries = [["", []]], open = [] } = {}) {
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = "/repo";
  explorer.gen = 1;
  explorer.entries = new Map(entries);
  explorer.open = new Set(open);
  return { explorer, cx };
}

/** Renders once and returns the v_virtual_list calls it made. */
function render(explorer, cx) {
  resetUi();
  explorer.render(cx);
  return callsNamed("v_virtual_list");
}

/** The id a row element was built with. */
const idOf = el => el.calls.find(c => c.name === "id")?.args[0];

/** The key down a test sends to the view. */
const key = (explorer, cx, k) => explorer.key({ keystroke: k, key_char: k }, cx);

/** The indices passed to the tree's (or Find files') scroll handle, in order. */
const scrolls = handle => handle.calls.filter(c => c.name === "scroll_to_item").map(c => c.args[0]);

/** The scroll handle a recorded virtual list is bound to (via track_scroll), or undefined. */
const tracked = list => list.el.calls.find(c => c.name === "track_scroll")?.args[0];

/** The gw label drawn on a rendered row element, or null. */
function labelOf(el) {
  for (const kid of el.kids ?? []) {
    if (!kid || typeof kid !== "object") continue;
    if (kid.calls?.some(c => c.name === "font_semibold")) {
      const text = kid.kids.find(k => typeof k === "string");
      if (text) return text;
    }
    const nested = labelOf(kid);
    if (nested) return nested;
  }
  return null;
}

/** `n` Find files rows under one folder, for the Find files list tests. */
const foundRows = n => Array.from({ length: n }, (_, i) => ({
  path: `a/file-${String(i).padStart(4, "0")}.ts`, name: `file-${String(i).padStart(4, "0")}.ts`,
  depth: 1, dir: false, hits: [[2, 3]],
}));

/** A listing as listing.js's script prints it, for the reveal test's folder loads. */
const listing = entries => entries.map(e => `${e.dir ? "d" : "f"}\0${e.name}\0`).join("");

test("tree: one v_virtual_list with the row count and row height", () => {
  const { explorer, cx } = seededExplorer({ entries: [["", flat(120)]] });
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for the tree");
  assert.equal(lists[0].args[1], 120, "the list's item count is the row count");
  assert.equal(lists[0].args[2], ROW_H, "rows are 24 px tall");
  assert.equal(tracked(lists[0]), explorer.scroll, "the list tracks the tree's scroll handle");
  assert.ok(explorer.scroll instanceof VirtualListScrollHandle, "the tree handle is a VirtualListScrollHandle");
});

test("tree: the renderer returns exactly the rows of the range it is asked for", () => {
  const { explorer, cx } = seededExplorer({ entries: [["", flat(120)]] });
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for the tree");
  const [, , , getKey, build] = lists[0].args;
  assert.equal(getKey(3), "file-0003.js", "a row's key is its path");

  const els = build({ start: 10, end: 14 }, cx);
  assert.equal(els.length, 4, "the renderer builds only the rows in the range");
  assert.deepEqual(els.map(idOf), [
    "row-file-0010.js", "row-file-0011.js", "row-file-0012.js", "row-file-0013.js",
  ], "the rows are the ones at the range's indices");
});

test("tree: refresh drops the cached rows of a folder that went away", async () => {
  const { explorer, cx } = seededExplorer({
    entries: [
      ["", [{ name: "gone", dir: true }, { name: "slow", dir: true }, { name: "keep.js", dir: false }]],
      ["gone", [{ name: "stale.js", dir: false }]],
      ["slow", [{ name: "wait.js", dir: false }]],
    ],
    open: ["gone", "slow"],
  });
  assert.deepEqual(explorer.rows().map(r => r.path),
    ["gone", "gone/stale.js", "slow", "slow/wait.js", "keep.js"],
    "the cached rows start with both folders open");

  let releaseSlow = () => {};
  const slow = new Promise(resolve => {
    releaseSlow = () => resolve({ code: 0, stdout: "f\0wait.js\0", stderr: "" });
  });
  const listed = [];
  onExec("sh", (_command, args) => {
    const path = args[3];
    listed.push(path);
    if (path === "/repo/gone") return Promise.resolve({ code: 1, stdout: "", stderr: "gone" });
    if (path === "/repo/slow") return slow;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });

  explorer.refresh(cx);
  await flush();
  assert.ok(!explorer.open.has("gone"), "the missing folder is closed");
  assert.ok(listed.includes("/repo/slow"), "the refresh is still waiting on the second folder");
  assert.deepEqual(explorer.rows().map(r => r.path),
    ["gone", "slow", "slow/wait.js", "keep.js"],
    "rows cached from the closed folder are dropped while the refresh is still running");

  releaseSlow();
  await flush();
});

test("find: one v_virtual_list with the row count and row height", () => {
  const { explorer, cx } = seededExplorer();
  explorer.findQuery = "file";
  explorer.found = [{ path: "a/file-0000.ts", hits: [2, 3, 4, 5], score: 1 }];
  explorer.frows = Array.from({ length: 90 }, (_, i) => ({
    path: `a/file-${String(i).padStart(4, "0")}.ts`, name: `file-${String(i).padStart(4, "0")}.ts`,
    depth: 1, dir: false, hits: [[2, 3], [4, 5]],
  }));

  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for Find files");
  assert.equal(lists[0].args[1], 90, "the list's item count is the matched row count");
  assert.equal(lists[0].args[2], ROW_H, "rows are 24 px tall");
  assert.equal(tracked(lists[0]), explorer.fscroll, "the list tracks the Find files scroll handle");
  assert.ok(explorer.fscroll instanceof VirtualListScrollHandle, "the Find files handle is a VirtualListScrollHandle");

  const [, , , getKey, build] = lists[0].args;
  assert.equal(getKey(2), "a/file-0002.ts", "a row's key is its path");
  const els = build({ start: 5, end: 7 }, cx);
  assert.equal(els.length, 2, "the renderer builds only the rows in the range");
  assert.deepEqual(els.map(idOf), ["found-a/file-0005.ts", "found-a/file-0006.ts"]);
});

test("tree: on_item_click toggles a folder, opens a file and moves the cursor", async () => {
  const { explorer, cx } = seededExplorer({
    entries: [["", [{ name: "src", dir: true }, { name: "a.js", dir: false }]],
      ["src", [{ name: "main.js", dir: false }]]],
  });
  const opened = [];
  explorer.router.open = async (path, opts) => { opened.push({ path, focus: opts.focus }); return null; };
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for the tree");
  const click = lists[0].el.calls.find(c => c.name === "on_item_click").args[0];

  click("src", cx);
  assert.equal(explorer.cursor, "src", "a click moves the cursor to the row");
  assert.ok(explorer.open.has("src"), "clicking a folder toggles it open");
  assert.ok(explorer.handle.is_focused(), "a click takes the keyboard");
  assert.deepEqual(explorer.rows().map(r => r.path), ["src", "src/main.js", "a.js"],
    "the opened folder's rows are in the list");

  click("src", cx);
  assert.ok(!explorer.open.has("src"), "clicking it again folds it");

  click("a.js", cx);
  assert.equal(explorer.cursor, "a.js", "clicking a file selects its row");
  await flush();
  assert.deepEqual(opened, [{ path: "/repo/a.js", focus: true }],
    "clicking a file opens that file in Helix, focused");
  assert.deepEqual(cx.errors(), [], "opening a file adopts no error");
});

test("find: on_item_click folds a folder and selects a file", async () => {
  const { explorer, cx } = seededExplorer();
  explorer.findQuery = "x";
  explorer.found = [
    { path: "a/x.ts", hits: [2], score: 1 },
    { path: "a/y.ts", hits: [2], score: 1 },
    { path: "b.ts", hits: [0], score: 1 },
  ];
  explorer.buildFiltered();
  const opened = [];
  explorer.router.open = async (path, opts) => { opened.push({ path, focus: opts.focus }); return null; };
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for Find files");
  const click = lists[0].el.calls.find(c => c.name === "on_item_click").args[0];
  assert.deepEqual(explorer.frows.map(r => r.path), ["a", "a/x.ts", "a/y.ts", "b.ts"]);

  click("a", cx);
  assert.equal(explorer.fsel, 0, "folding a folder keeps its row selected");
  assert.deepEqual(explorer.frows.map(r => r.path), ["a", "b.ts"], "the folder's rows fold away");

  click("b.ts", cx);
  assert.equal(explorer.fsel, 1, "clicking a file selects it");
  await flush();
  assert.deepEqual(opened, [{ path: "/repo/b.ts", focus: true }],
    "clicking a Find files file opens that file in Helix, focused");
  assert.deepEqual(cx.errors(), [], "opening a file adopts no error");
});

test("tree: j, k, gg, ge and reveal scroll the list to the cursor's row", async () => {
  const { explorer, cx } = seededExplorer({
    entries: [["", [{ name: "src", dir: true }, ...flat(1)]]],
  });
  onExec("sh", (_command, args) => ({
    code: 0,
    stdout: listing(args[3] === "/repo" ? [{ name: "src", dir: true }] : [{ name: "x.js", dir: false }]),
    stderr: "",
  }));

  key(explorer, cx, "j");
  assert.equal(explorer.cursor, "src", "j from no cursor lands on the first row");
  assert.equal(scrolls(explorer.scroll).at(-1), 0, "j scrolls to the row it moved to");

  key(explorer, cx, "j");
  assert.equal(explorer.cursor, "file-0000.js");
  assert.equal(scrolls(explorer.scroll).at(-1), 1, "j scrolls to the next row");

  key(explorer, cx, "k");
  assert.equal(explorer.cursor, "src", "k moves back");
  assert.equal(scrolls(explorer.scroll).at(-1), 0, "k scrolls to the row it moved to");

  key(explorer, cx, "g");
  key(explorer, cx, "e");
  assert.equal(explorer.cursor, "file-0000.js", "ge goes to the last row");
  assert.equal(scrolls(explorer.scroll).at(-1), 1, "ge scrolls to the last row");

  key(explorer, cx, "g");
  key(explorer, cx, "g");
  assert.equal(explorer.cursor, "src", "gg goes to the top row");
  assert.equal(scrolls(explorer.scroll).at(-1), 0, "gg scrolls to the top row");

  // Reveal: the file under a closed folder; the folder loads, then the row is scrolled to.
  explorer.runtime = "/run/herdr-explorer";
  const reveal = "term1\t/repo/src/x.js\n";
  state.readTextFile = path => (String(path).endsWith("/reveal") ? reveal : null);
  await explorer.reveal(cx);
  assert.equal(explorer.cursor, "src/x.js", "reveal selects the file");
  const rows = explorer.rows();
  assert.equal(scrolls(explorer.scroll).at(-1), rows.findIndex(r => r.path === "src/x.js"),
    "reveal scrolls to the cursor's row");
});

test("find: the list tracks the Find files handle and j, k, gg, ge reveal the selected row", () => {
  const { explorer, cx } = seededExplorer();
  explorer.findQuery = "file";
  explorer.frows = foundRows(120);

  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one v_virtual_list for Find files");
  const handle = tracked(lists[0]);
  assert.ok(handle, "the list tracks a scroll handle");
  assert.equal(handle, explorer.fscroll, "the handle is the one the cursor keys scroll");
  assert.equal(scrolls(handle).length, 0, "rendering alone does not scroll");

  key(explorer, cx, "j");
  assert.equal(explorer.fsel, 1, "j moves the selection down");
  assert.equal(scrolls(explorer.fscroll).at(-1), 1, "j scrolls the list to the selected row");

  key(explorer, cx, "k");
  assert.equal(explorer.fsel, 0, "k moves back");
  assert.equal(scrolls(explorer.fscroll).at(-1), 0, "k scrolls the list to the selected row");

  key(explorer, cx, "g");
  key(explorer, cx, "e");
  assert.equal(explorer.fsel, 119, "ge goes to the last row");
  assert.equal(scrolls(explorer.fscroll).at(-1), 119, "ge scrolls to the last row");

  // gg runs after ge, so its scroll to row 0 must be a fresh call, not one left over from k.
  const before = scrolls(explorer.fscroll).length;
  key(explorer, cx, "g");
  key(explorer, cx, "g");
  assert.equal(explorer.fsel, 0, "gg goes to the first row");
  assert.equal(scrolls(explorer.fscroll).length, before + 1, "gg scrolls the list once");
  assert.equal(scrolls(explorer.fscroll).at(-1), 0, "gg scrolls to the first row");
});

test("tree: gw labels the rows the scroll handle reports as visible", () => {
  const { explorer, cx } = seededExplorer({ entries: [["", flat(200)]] });

  explorer.scroll.setViewport(240).setOffset(0);
  key(explorer, cx, "g");
  key(explorer, cx, "w");
  assert.ok(explorer.jump, "gw labels rows while focused");
  assert.equal(explorer.jump.at.get("a"), 0, "the first label is the first visible row");
  assert.equal(explorer.jump.at.get("j"), 9, "the labels cover the rows at least half on screen");

  explorer.jump = null;
  explorer.scroll.setOffset(2400);
  key(explorer, cx, "g");
  key(explorer, cx, "w");
  assert.equal(explorer.jump.at.get("a"), 100, "the labels start at the scrolled-to row");
  assert.equal(explorer.jump.at.get("j"), 109, "and cover the visible rows from there");

  key(explorer, cx, "c");
  assert.equal(explorer.jump, null, "typing the whole label ends the jump");
  assert.equal(explorer.cursor, explorer.rows()[102].path, "the label moves the cursor to its row");
  assert.equal(scrolls(explorer.scroll).at(-1), 102, "and scrolls that row into view");
});

test("tree: gw labels the visible rendered rows only, with the note above them", () => {
  const { explorer, cx } = seededExplorer({ entries: [["", flat(5000)]] });
  explorer.handle.focus();
  explorer.scroll.setViewport(240).setOffset(13);

  key(explorer, cx, "g");
  key(explorer, cx, "w");
  assert.ok(explorer.jump, "gw labels the tree");

  const lists = render(explorer, cx);
  assert.ok(callsNamed("child").some(c => c.args[0] === "Showing the first 5,000 entries"),
    "the note is above the rows");
  // The host asks for the visible rows plus overscan; only rows 1..10 are at least half on screen.
  const rows = lists[0].args[4]({ start: 0, end: 14 }, cx);
  assert.deepEqual(rows.map(labelOf), [
    null, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", null, null, null,
  ], "labels reach the visible rows, not the note or the overscan rows");
});

test("find: gw labels the Find files rows the handle reports as visible", () => {
  const { explorer, cx } = seededExplorer();
  explorer.findQuery = "file";
  explorer.found = [{ path: "a/file-0000.ts", hits: [2], score: 1 }];
  explorer.frows = Array.from({ length: 200 }, (_, i) => ({
    path: `a/file-${String(i).padStart(4, "0")}.ts`, name: `file-${String(i).padStart(4, "0")}.ts`,
    depth: 1, dir: false, hits: [[2, 3]],
  }));
  explorer.fscroll.setViewport(240).setOffset(0);

  key(explorer, cx, "g");
  key(explorer, cx, "w");
  assert.ok(explorer.jump, "gw labels Find files rows");
  assert.equal(explorer.jump.at.get("a"), 0, "the first label is the first visible row");
  assert.equal(explorer.jump.at.get("j"), 9, "the labels cover the visible rows");

  key(explorer, cx, "c");
  assert.equal(explorer.fsel, 2, "the label selects its row");
  assert.equal(scrolls(explorer.fscroll).at(-1), 2, "and scrolls it into view");
});

test("find: gw labels the visible rendered Find files rows only, with the note above them", () => {
  const { explorer, cx } = seededExplorer();
  explorer.findQuery = "file";
  explorer.found = foundRows(200);
  explorer.frows = foundRows(200);
  explorer.handle.focus();
  explorer.fscroll.setViewport(240).setOffset(13);

  key(explorer, cx, "g");
  key(explorer, cx, "w");
  assert.ok(explorer.jump, "gw labels the Find files rows");

  const lists = render(explorer, cx);
  assert.ok(callsNamed("child").some(c => c.args[0] === "Best 200 matches: keep typing"),
    "the note is above the rows");
  // The host asks for the visible rows plus overscan; only rows 1..10 are at least half on screen.
  const rows = lists[0].args[4]({ start: 0, end: 14 }, cx);
  assert.deepEqual(rows.map(labelOf), [
    null, "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", null, null, null,
  ], "labels reach the visible rows, not the note or the overscan rows");
});
