// The test facilities themselves: each stub behaves as the host API that later tasks rely on.
//
// These pin the fixes a review found, so a regression shows up here rather than as a confusing
// failure in a refresh, search or reveal test.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { readTextFile, realExec, reset, resolveWatch, state, watchFolder, watches } from "herdr";
import { InputState, VirtualListScrollHandle, resetUi, setInputContext } from "gpui-base";
import { createCx, flush } from "./stubs/cx.mjs";

beforeEach(() => {
  reset();
  resetUi();
});

// ---- cx: timers run in due-time order ----

test("cx.advance: timers run at their own due time, in due-time order", () => {
  const cx = createCx();
  const ran = [];
  cx.timer.after(100, () => ran.push(["slow", cx.now]));
  cx.timer.after(20, () => ran.push(["fast", cx.now]));
  cx.advance(100);
  assert.deepEqual(ran, [["fast", 20], ["slow", 100]]);
});

test("cx.advance: sleeps and timers interleave by deadline", async () => {
  const cx = createCx();
  const ran = [];
  const slept = cx.sleep(60).then(() => ran.push(["sleep", cx.now]));
  cx.timer.after(30, () => ran.push(["timer", cx.now]));
  cx.advance(60);
  await slept;
  assert.deepEqual(ran, [["timer", 30], ["sleep", 60]]);
});

// ---- input focus and blur: the host passes (event, cx) ----

test("InputState: focus and blur hand the view's cx to handlers that notify", () => {
  const cx = createCx();
  setInputContext(cx);
  const input = InputState.new({ placeholder: "find" });
  let typing = null;
  input.on("focus", (_event, cx) => { typing = "find"; cx.notify(); });
  input.on("blur", (_event, cx) => { typing = null; cx.notify(); });

  input.focus();
  assert.equal(typing, "find");
  assert.equal(cx.notifications, 1);

  input.blur();
  assert.equal(typing, null);
  assert.equal(cx.notifications, 2);
});

test("InputState: a context set after the input exists still reaches its handlers", () => {
  const input = InputState.new({ placeholder: "find" });
  let got = null;
  input.on("focus", (_event, cx) => { got = cx; cx.notify(); });
  const cx = setInputContext(createCx());
  input.focus();
  assert.equal(got, cx);
  assert.equal(cx.notifications, 1);
});

test("InputState: a handler still gets a usable cx when a test supplies none", () => {
  const input = InputState.new({});
  let notified = 0;
  input.on("focus", (_event, cx) => { cx.notify(); notified++; });
  input.focus();
  assert.equal(notified, 1);
});

// ---- reset: outstanding watches are detached, not settled ----

test("reset: a pending watch stays pending, so the previous test's view cannot resume", async () => {
  let resumed = false;
  const pending = watchFolder("/repo").then(() => { resumed = true; });
  assert.equal(watches.length, 1);

  reset();
  assert.equal(watches.length, 0);
  assert.equal(resolveWatch("/repo", ["/repo/a"]), false);
  await flush();
  assert.equal(resumed, false);

  void pending; // it never settles, by design
});

// ---- readTextFile: the host function is async ----

test("readTextFile: always a promise, for the null default and for a synchronous fixture", async () => {
  const defaulted = readTextFile("/missing/reveal");
  assert.ok(defaulted instanceof Promise);
  assert.equal(await defaulted, null);

  state.readTextFile = () => "pair-1\t/repo/src/a.js\n";
  const scripted = readTextFile("/repo/reveal");
  assert.ok(scripted instanceof Promise);
  assert.equal(await scripted, "pair-1\t/repo/src/a.js\n");
});

// ---- realExec: a signal-killed child is a failure ----

test("realExec: a child killed by a signal exits -1, and a plain status is kept", async () => {
  const killed = await realExec("sh", ["-c", "kill -TERM $$"]);
  assert.equal(killed.code, -1);

  const failed = await realExec("sh", ["-c", "exit 3"]);
  assert.equal(failed.code, 3);

  const ok = await realExec("sh", ["-c", "printf hi"]);
  assert.deepEqual({ code: ok.code, stdout: ok.stdout }, { code: 0, stdout: "hi" });
});

// ---- gpui-base: the virtual list's scroll handle ----

test("VirtualListScrollHandle: records scrolling and reports the offset and viewport a test sets", () => {
  const handle = VirtualListScrollHandle.new();
  handle.scroll_to_item(5);
  handle.scroll_to_item(2, "center");
  handle.scroll_to_bottom();

  assert.deepEqual(handle.calls, [
    { name: "new", args: [] },
    { name: "scroll_to_item", args: [5, "top"] },
    { name: "scroll_to_item", args: [2, "center"] },
    { name: "scroll_to_bottom", args: [] },
  ]);
  assert.equal(handle.offset().y, 48);

  handle.setViewport(240, 400);
  assert.deepEqual(handle.viewport_size(), { width: 400, height: 240 });

  handle.setOffset(72);
  assert.equal(handle.offset().y, 72);
});
