// C-13: the Explorer picks up the Find files / Search request bin/herdr-explorer left behind.
//
// The CLI no longer sleeps for the panel: it writes `command` (command, whether a text argument
// was given, timestamp, text) into the runtime folder and wakes the mod. So the mod reads it when
// it starts, when woken with `herdr-explorer.pending`, and when its folder watch fires; it applies
// each request once (across a fresh copy of the mod too), and ignores one older than 5 s (a
// request from a CLI run long ago must not resurface).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { calls, pushCommand, reset, resolveWatch, state } from "herdr";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";
import { resetUi } from "./stubs/ui.mjs";

const RUNTIME = "/tmp/herdr-explorer-test-runtime";
const COMMAND = `${RUNTIME}/command`;

/** What bin/herdr-explorer writes: command, 1/0 for a text argument, timestamp (ms), text. */
const request = (command, text, at = Date.now()) =>
  `${command}\t${text === undefined ? "0" : "1"}\t${at}\t${text ?? ""}\n`;

let files;

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
  files = new Map();
  // The runtime folder the mod finds through the shell, and the request files in it.
  state.exec = () => ({ code: 0, stdout: RUNTIME, stderr: "" });
  state.readTextFile = path => files.get(path) ?? null;
});

function startup() {
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  return { explorer, cx };
}

test("pending command: a request written before the panel started is applied at init", async () => {
  files.set(COMMAND, request("find-files", "foo"));
  const { explorer, cx } = startup();
  await flush();

  assert.equal(explorer.runtime, RUNTIME);
  assert.equal(explorer.view, "tree");
  assert.equal(explorer.findQuery, "foo");
  assert.equal(explorer.findInput.value(), "foo");
  assert.ok(cx.notifications > 0, "the applied request is rendered");
});

test("pending command: a wake during the initial read causes a follow-up read", async () => {
  let release;
  let reads = 0;
  state.readTextFile = path => {
    if (path !== COMMAND) return null;
    reads++;
    if (reads === 1) return new Promise(resolve => { release = resolve; });  // a slow snapshot
    return files.get(path) ?? null;
  };

  const { explorer } = startup();
  await flush();
  assert.equal(reads, 1, "the initial snapshot is still in flight");

  // The CLI publishes and wakes while the snapshot taken before it has not answered yet.
  files.set(COMMAND, request("find-files", "late"));
  pushCommand("pending");
  await flush();

  release(null);  // that snapshot found no request
  await flush(60);

  assert.ok(reads >= 2, "the wake caused a follow-up read");
  assert.equal(explorer.findQuery, "late");
  assert.equal(explorer.findInput.value(), "late");
});

test("pending command: the CLI's wake applies a request written while the panel ran", async () => {
  const { explorer } = startup();
  await flush();
  assert.equal(explorer.findQuery, "");

  files.set(COMMAND, request("search", "needle"));
  pushCommand("pending");  // herdr-app do herdr-explorer.pending
  await flush();

  assert.equal(explorer.view, "search");
  assert.equal(explorer.searchInput.value(), "needle");
});

test("pending command: a folder watch batch naming the request applies it once", async () => {
  const { explorer, cx } = startup();
  await flush();

  files.set(COMMAND, request("find-files", "bar"));
  assert.ok(resolveWatch(RUNTIME, [`${RUNTIME}/command`]), "the runtime folder is watched");
  await flush();
  assert.equal(explorer.findQuery, "bar");
  const applied = cx.notifications;

  // The same request stays on disk; a later batch must not apply it again.
  assert.ok(resolveWatch(RUNTIME, [COMMAND]), "the watch is re-armed");
  await flush();
  assert.equal(cx.notifications, applied, "the same request was applied twice");
  assert.equal(explorer.findQuery, "bar");
});

test("pending command: a newer request is applied after an older one", async () => {
  files.set(COMMAND, request("find-files", "one"));
  const { explorer } = startup();
  await flush();
  assert.equal(explorer.findQuery, "one");

  files.set(COMMAND, request("find-files", "two"));
  pushCommand("pending");
  await flush();
  assert.equal(explorer.findQuery, "two");
});

test("pending command: a request already applied is not applied again by a fresh copy", async () => {
  files.set(COMMAND, request("search", "needle"));
  const first = startup();
  await flush();
  assert.equal(first.explorer.view, "search");
  assert.equal(first.explorer.searchInput.value(), "needle");

  // A reload or another copy of the mod starts its own init against the same request on disk.
  const second = startup();
  await flush();
  assert.equal(second.explorer.runtime, RUNTIME);
  assert.equal(second.explorer.view, "tree", "the consumed request was applied twice");
  assert.equal(second.explorer.searchInput.value(), "");

  // A newer publication is a new wish, even in the fresh copy.
  files.set(COMMAND, request("search", "fresh"));
  assert.ok(resolveWatch(RUNTIME, [COMMAND]), "the fresh copy watches the runtime folder");
  await flush();
  assert.equal(second.explorer.view, "search");
  assert.equal(second.explorer.searchInput.value(), "fresh");
});

test("pending command: a request older than 5 s is ignored", async () => {
  files.set(COMMAND, request("find-files", "stale", Date.now() - 6000));
  const { explorer } = startup();
  await flush();

  assert.equal(explorer.findQuery, "");
  assert.equal(explorer.findInput.value(), "");
  // It was read and judged stale, not applied.
  assert.ok(calls.readTextFile.some(c => c.path === COMMAND));
});

test("pending command: a tab in the text survives the handoff", async () => {
  files.set(COMMAND, request("search", "left\tright"));
  const { explorer } = startup();
  await flush();

  assert.equal(explorer.view, "search");
  assert.equal(explorer.searchInput.value(), "left\tright", "the text after the framing keeps its tabs");
});

test("pending command: an explicit empty text clears the query and an omitted one leaves it", async () => {
  const { explorer } = startup();
  await flush();

  files.set(COMMAND, request("find-files", "doc"));
  pushCommand("pending");
  await flush();
  assert.equal(explorer.findQuery, "doc");

  files.set(COMMAND, request("find-files"));  // no argument
  pushCommand("pending");
  await flush();
  assert.equal(explorer.findQuery, "doc", "an omitted text must not clear the query");

  files.set(COMMAND, request("find-files", ""));  // an explicit empty argument
  pushCommand("pending");
  await flush();
  assert.equal(explorer.findQuery, "");
  assert.equal(explorer.findInput.value(), "");
});

test("pending command: a redundant wake keeps the g prefix", async () => {
  const { explorer, cx } = startup();
  await flush();

  files.set(COMMAND, request("find-files", "bar"));
  assert.ok(resolveWatch(RUNTIME, [COMMAND]), "the runtime folder is watched");
  await flush();
  assert.equal(explorer.findQuery, "bar");

  explorer.findInput.blur();  // back on the list, no input has the keyboard
  assert.equal(explorer.typing, null);
  explorer.key({ key_char: "g", keystroke: "g" }, cx);
  assert.equal(explorer.pending, "g");

  pushCommand("pending");  // the CLI's wake arrives with nothing new to apply
  await flush();
  assert.equal(explorer.pending, "g", "a wake with no request must not cancel gg / ge / gw");

  pushCommand("focus");  // not a Find files or Search action
  await flush();
  assert.equal(explorer.pending, "g", "only Find files and Search clear the prefix");

  pushCommand("find-files:doc");  // an actual Find files action does clear it
  await flush();
  assert.equal(explorer.pending, null);
  assert.equal(explorer.findQuery, "doc");
});

test("command: find-files:TEXT and search:TEXT still start with that text", async () => {
  const { explorer, cx } = startup();
  await flush();

  explorer.command("find-files:doc", cx);
  assert.equal(explorer.findQuery, "doc");

  explorer.command("search:body", cx);
  assert.equal(explorer.view, "search");
  assert.equal(explorer.searchInput.value(), "body");
});
