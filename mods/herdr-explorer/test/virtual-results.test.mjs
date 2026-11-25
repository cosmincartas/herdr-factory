// C-6b: the search results are a virtual list (P2, P6).
//
// The results list used to build one element per row in render(), inside a plain scroll area, so
// 4,000 rows (2,000 matches in 2,000 files) cost the whole render budget. It is now a
// `v_virtual_list` with the two fixed heights Task 4's spike chose — a file row and a match row —
// clicks arrive once per list through `on_item_click` with the row's key, and the scroll handle is
// a `VirtualListScrollHandle` so the selection keeps scrolling into view. The row array is built
// once per change of the results or their folds, not again for every render and key press.
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

// The heights Task 4 measured: a file row is 6 px above a 22 px row, a match row 18 px plus 1 px
// of padding each side.
const FILE_H = 28, MATCH_H = 20;

/** A search result with `files` files, each holding `per` matches on consecutive lines. */
function results(files, per = 1) {
  const out = [];
  for (let i = 0; i < files; i++) {
    const path = `src/file-${String(i).padStart(4, "0")}.js`;
    out.push({
      path,
      matches: Array.from({ length: per }, (_, n) => ({
        line: n + 1, col: 3, text: `const value${n} = ${i};`, ranges: [[6, 11]],
      })),
    });
  }
  return { files: out, total: files * per, truncated: false };
}

/** A seeded Explorer in the Search view: checking() stops init before the timers and watch start. */
function seededExplorer(res) {
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = "/repo";
  explorer.gen = 1;
  explorer.entries = new Map([["", []]]);
  explorer.view = "search";
  explorer.results = res;
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

/** The text a rendered row draws, in order: its string children, depth first. */
function drawn(el) {
  const out = [];
  const walk = node => {
    if (typeof node === "string") { out.push(node); return; }
    for (const kid of node?.kids ?? []) walk(kid);
  };
  walk(el);
  return out;
}

/** An `rg --json` match line: `matched` starts at `lineText.indexOf(matched)`, so the column follows. */
function rgMatch(file, lineText, line, matched) {
  const at = lineText.indexOf(matched);
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: `./${file}` },
      lines: { text: `${lineText}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: [{ match: { text: matched }, start: at, end: at + matched.length }],
    },
  });
}

/** The key down a test sends to the view. */
const key = (explorer, cx, k) => explorer.key({ keystroke: k, key_char: k }, cx);

/** The indices passed to the results scroll handle, in order. */
const scrolls = handle => handle.calls.filter(c => c.name === "scroll_to_item").map(c => c.args[0]);

/** The scroll handle a recorded virtual list is bound to (via track_scroll), or undefined. */
const tracked = list => list.el.calls.find(c => c.name === "track_scroll")?.args[0];

/** Renders the results list and clicks the row at `index`, through its `on_item_click`. */
function clickRow(explorer, cx, index) {
  const list = render(explorer, cx)[0];
  const [, count, , getKey] = list.args;
  const click = list.el.calls.find(c => c.name === "on_item_click").args[0];
  click(getKey(Math.max(0, Math.min(index, count - 1))), cx);
}

test("search: one virtual list, with a height per row", () => {
  const { explorer, cx } = seededExplorer(results(2, 2));
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one virtual list for the search results");
  assert.equal(lists[0].args[1], 6, "two file rows and their four match rows");
  assert.deepEqual(lists[0].args[2], [FILE_H, MATCH_H, MATCH_H, FILE_H, MATCH_H, MATCH_H],
    "a file row is 28 px tall and a match row 20 px");
  assert.equal(tracked(lists[0]), explorer.rscroll, "the list tracks the results scroll handle");
  assert.ok(explorer.rscroll instanceof VirtualListScrollHandle,
    "the results handle is a VirtualListScrollHandle, so the selection can scroll into view");

  const keys = Array.from({ length: 6 }, (_, i) => lists[0].args[3](i));
  assert.equal(new Set(keys).size, 6, "every row has its own key");
});

test("search: the renderer returns the rows of the range, in order, with their own content", () => {
  const { explorer, cx } = seededExplorer(results(2, 2));
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one virtual list for the search results");
  const [, , , , build] = lists[0].args;

  // Rows 2 and 3 cross a file boundary: the second match of src/file-0000.js, then the row of
  // src/file-0001.js. A renderer that returned the right count in another order would draw a
  // different match under each clickable key.
  const els = build({ start: 2, end: 4 }, cx);
  assert.equal(els.length, 2, "the renderer builds only the rows in the range");
  assert.equal(idOf(els[0]), "result-2", "the first row is the one at the range's start index");
  assert.deepEqual(els.map(drawn), [
    ["2", "const ", "value", "1 = 0;"],
    ["file-0001.js", "src", "2"],
  ], "the rows are the match and the file at indices 2 and 3, in that order");
});

test("search: on_item_click folds a file row and opens a match at its line and column", async () => {
  const res = {
    files: [
      { path: "a/x.js", matches: [{ line: 5, col: 3, text: "const hit = 1;", ranges: [[6, 9]] }] },
      { path: "b/y.js", matches: [{ line: 9, col: 7, text: "hit();", ranges: [[0, 3]] }] },
    ],
    total: 2,
    truncated: false,
  };
  const { explorer, cx } = seededExplorer(res);
  const opened = [];
  explorer.router.open = async (path, opts) => { opened.push({ path, focus: opts.focus }); return null; };

  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one virtual list for the search results");
  assert.equal(lists[0].args[1], 4, "two file rows and one match row each");

  clickRow(explorer, cx, 0);
  assert.ok(explorer.collapsed.has("a/x.js"), "clicking a file row folds its matches away");
  assert.equal(explorer.ssel, 0, "the folded file's row stays selected");
  assert.equal(explorer.resultRows().length, 3, "the match row folded away");
  assert.deepEqual(opened, [], "folding a file opens nothing");

  clickRow(explorer, cx, 2);
  await flush();
  assert.deepEqual(opened, [{ path: "/repo/b/y.js:9:7", focus: true }],
    "clicking a match row opens the file at its line and column");
  assert.equal(explorer.ssel, 2, "clicking a match row selects it");
  assert.deepEqual(cx.errors(), [], "opening a file adopts no error");
});

test("search: j, k, gg and ge scroll the selection into view", () => {
  const { explorer, cx } = seededExplorer(results(100));  // 200 rows
  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one virtual list for the search results");
  assert.equal(tracked(lists[0]), explorer.rscroll, "the list tracks the results scroll handle");
  assert.equal(scrolls(explorer.rscroll).length, 0, "rendering alone does not scroll");

  key(explorer, cx, "j");
  assert.equal(explorer.ssel, 1, "j moves the selection down");
  assert.equal(scrolls(explorer.rscroll).at(-1), 1, "j scrolls the selected row into view");

  key(explorer, cx, "k");
  assert.equal(explorer.ssel, 0, "k moves back");
  assert.equal(scrolls(explorer.rscroll).at(-1), 0, "k scrolls the selected row into view");

  key(explorer, cx, "g");
  key(explorer, cx, "e");
  assert.equal(explorer.ssel, 199, "ge goes to the last row");
  assert.equal(scrolls(explorer.rscroll).at(-1), 199, "ge scrolls the last row into view");

  key(explorer, cx, "g");
  key(explorer, cx, "g");
  assert.equal(explorer.ssel, 0, "gg goes to the first row");
  assert.equal(scrolls(explorer.rscroll).at(-1), 0, "gg scrolls the first row into view");
});

test("search: the rows are built once per change of the results or their folds", () => {
  const counter = { builds: 0 };
  const file = i => {
    const matches = [{ line: 1, col: 1, text: `hit ${i}`, ranges: [[0, 3]] }];
    return { path: `${String.fromCharCode(97 + i)}.js`, get matches() { counter.builds++; return matches; } };
  };
  const { explorer, cx } = seededExplorer({ files: [file(0), file(1), file(2)], total: 3, truncated: false });

  const lists = render(explorer, cx);
  assert.equal(lists.length, 1, "one virtual list for the search results");
  assert.equal(counter.builds, 3, "the first render reads each file's matches once");
  const sizes = lists[0].args[2];

  render(explorer, cx);
  key(explorer, cx, "j");
  key(explorer, cx, "k");
  const again = render(explorer, cx);
  assert.equal(counter.builds, 3, "a render and the cursor keys reuse the built rows");
  assert.equal(again[0].args[2], sizes, "the same heights serve every render until a fold");

  clickRow(explorer, cx, 0);
  assert.equal(counter.builds, 6, "folding a file rebuilds the rows once");
});

// T6-01: a row's key carries the revision of the result set that drew it. Search keeps the old rows
// visible while a new query runs, and the host holds a press and its release across a redraw by the
// hit box's key: the release must open the match that was drawn under the pointer, or nothing — never
// the different match that took the same position in a replacement result set (P2, C-6b).

test("search: a click that lands after the results were replaced opens nothing, not another match", async () => {
  const before = {
    files: [{ path: "src/a.js", matches: [{ line: 5, col: 3, text: "const hit = 1;", ranges: [[6, 9]] }] }],
    total: 1,
    truncated: false,
  };
  const { explorer, cx } = seededExplorer(before);
  const opened = [];
  explorer.router.open = async (path, opts) => { opened.push({ path, focus: opts.focus }); return null; };

  const pressed = render(explorer, cx)[0].args[3](1);  // the match row drawn under the pointer: 5:3

  // The query changed, and ripgrep settled between the press and the release: the same file's first
  // match now sits on line 19, at the same row index.
  onExec(/rg --no-config --json/, () => ({ code: 0, stderr: "", stdout: rgMatch("src/a.js", "const hit();", 19, "hit") }));
  explorer.searchInput.set_value("other");
  explorer.scheduleSearch(cx);
  cx.advance(300);
  await flush(50);
  assert.deepEqual(explorer.resultRows().map(r => [r.kind, r.path, r.line, r.col]), [
    ["file", "src/a.js", undefined, undefined],
    ["match", "src/a.js", 19, 7],
  ], "the replacement rows are drawn: the first match is now on line 19, column 7");

  const click = render(explorer, cx)[0].el.calls.find(c => c.name === "on_item_click").args[0];
  click(pressed, cx);  // the release, with the key of the row that was drawn before the redraw
  await flush();
  assert.deepEqual(opened, [],
    "the click resolved against a replacement row instead of the one that was drawn under it");

  // The row now drawn at that position still opens its own match.
  click(render(explorer, cx)[0].args[3](1), cx);
  await flush();
  assert.deepEqual(opened, [{ path: "/repo/src/a.js:19:7", focus: true }],
    "the row drawn after the redraw opens its own match");
});

test("search: a fold keeps the other rows' keys, so a pending click still opens the drawn match", async () => {
  const res = {
    files: [
      { path: "a/x.js", matches: [{ line: 2, col: 1, text: "hit();", ranges: [[0, 3]] }] },
      { path: "b/y.js", matches: [{ line: 9, col: 7, text: "hit();", ranges: [[0, 3]] }] },
    ],
    total: 2,
    truncated: false,
  };
  const { explorer, cx } = seededExplorer(res);
  const opened = [];
  explorer.router.open = async path => { opened.push(path); return null; };

  const list = render(explorer, cx)[0];
  const pressed = list.args[3](3);  // b/y.js's match row, drawn before the fold
  const click = list.el.calls.find(c => c.name === "on_item_click").args[0];
  click(list.args[3](0), cx);       // a press on a/x.js's file row folds it
  assert.deepEqual(explorer.resultRows().map(r => r.path), ["a/x.js", "b/y.js", "b/y.js"],
    "the folded file's match row is gone, and b/y.js's rows shift up");

  click(pressed, cx);               // the release for b/y.js's row arrives after the fold
  await flush();
  assert.deepEqual(opened, ["/repo/b/y.js:9:7"], "the fold must not invalidate the row it did not change");
});
