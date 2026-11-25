// C-9: one content search at a time (P8).
//
// `exec` has no cancel handle, so a running ripgrep cannot be stopped. While it runs, a new query
// must not start a second rg: only the latest request is remembered and started once the running
// one settles, and the spinner stays on throughout.
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

/** A rg result the mod can parse: one match in src/a.js. */
const rgLine = (lineText, line, matched) => JSON.stringify({
  type: "match",
  data: {
    path: { text: "./src/a.js" },
    lines: { text: `${lineText}\n` },
    line_number: line,
    absolute_offset: 0,
    // rg reports byte offsets; "a here" and "abc here" are ASCII, so they are character offsets too.
    submatches: [{ match: { text: matched }, start: 0, end: matched.length }],
  },
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

/** An Explorer rooted at /repo with Search showing, and init's timers kept out of the way. */
function searchExplorer() {
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = "/repo";
  explorer.view = "search";
  return { explorer, cx };
}

test("three queries while the first rg runs: one rg, then one more with the last query", async () => {
  const { explorer, cx } = searchExplorer();

  const runs = []; // each rg invocation: { args, answer: deferred }
  onExec(/rg --no-config --json/, (_command, args) => {
    const answer = deferred();
    runs.push({ args, answer });
    return answer.promise;
  });

  // A keystroke: set the query, schedule, and let the debounce elapse.
  const type = async query => {
    explorer.searchInput.set_value(query);
    explorer.scheduleSearch(cx);
    cx.advance(300);
    await flush(50);
  };

  await type("a");
  assert.equal(runs.length, 1);
  assert.ok(runs[0].args.includes("a"));

  await type("ab");
  assert.equal(runs.length, 1, "concurrent rg: a second query started while the first was pending");
  assert.equal(explorer.searching, true, "the spinner stays on while a query waits");

  await type("abc");
  assert.equal(runs.length, 1, "concurrent rg: a third query started while the first was pending");
  assert.equal(explorer.searching, true, "the spinner stays on while a query waits");

  // The first rg settles: it is stale, so exactly one more starts, with the latest query.
  runs[0].answer.resolve({ code: 0, stdout: rgLine("a here", 1, "a"), stderr: "" });
  await flush(50);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].args[runs[1].args.length - 2], "abc", "the waiting search runs the last query");
  assert.equal(explorer.searching, true, "the spinner stays on across the handover");
  assert.equal(explorer.results, null, "the stale query's results are not shown");

  runs[1].answer.resolve({ code: 0, stdout: rgLine("abc here", 4, "abc"), stderr: "" });
  await flush(50);

  assert.deepEqual(explorer.results, {
    files: [{ path: "src/a.js", matches: [{ line: 4, col: 1, text: "abc here", ranges: [[0, 3]] }] }],
    total: 1,
    truncated: false,
  });
  assert.equal(explorer.searching, false, "the spinner stops when the last search is shown");
});
