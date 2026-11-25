// A fake GPUI `cx` for Node tests.
//
// `spawn` adopts a task like the host does (a rejection is kept, not thrown), `notify`,
// `stop_propagation`, `focus_handle` and `sleep` are recorded, and timers only run when the test
// advances the clock. Never await all spawned tasks: main.js's nextCommand loop never resolves.
// Settle with `flush()` (microtasks) or `flush(ms)` (a short real setTimeout) instead.

/** A focus handle, with a way for a test to move the keyboard. */
export function createFocusHandle() {
  const handle = {
    focused: false,
    focus() { handle.focused = true; handle.focusCalls++; return null; },
    is_focused() { return handle.focused; },
    release() { handle.focused = false; return true; },
    focusCalls: 0,
  };
  return handle;
}

/**
 * A context with manual time. `cx.advance(ms)` runs due timers and resolves due sleeps in order;
 * `flush()` drains promise callbacks. Fields: notifications, tasks, timers, sleeps, handles.
 */
export function createCx() {
  const cx = {
    now: 0,
    notifications: 0,
    stopped: 0,
    propagated: 0,
    tasks: [],
    timers: [],
    sleeps: [],
    handles: [],
    timerErrors: [],
    spawnCalls: 0,
  };

  cx.notify = () => { cx.notifications++; };
  cx.stop_propagation = () => { cx.stopped++; };
  cx.propagate = () => { cx.propagated++; };
  cx.focus_handle = () => { const handle = createFocusHandle(); cx.handles.push(handle); return handle; };
  cx.new = () => { throw new Error("cx.new is not stubbed"); };
  cx.phase = () => "render";
  cx.theme = () => ({});

  cx.spawn = body => {
    cx.spawnCalls++;
    const task = { done: false, error: null, result: undefined };
    task.promise = Promise.resolve()
      .then(() => body(cx))
      .then(result => { task.done = true; task.result = result; return result; },
        error => { task.done = true; task.error = error; return undefined; });
    cx.tasks.push(task);
    return task;
  };

  cx.sleep = (ms = 0) => new Promise(resolve => {
    cx.sleeps.push({ due: cx.now + Math.max(0, ms), resolve, done: false });
  });

  const addTimer = (due, repeat, handler) => {
    const timer = { due, repeat, handler, done: false, calls: 0 };
    cx.timers.push(timer);
    return { cancel: () => { timer.done = true; }, timer };
  };
  cx.timer = {
    after: (ms, handler) => addTimer(cx.now + Math.max(0, ms), 0, handler),
    every: (ms, handler) => addTimer(cx.now + Math.max(1, ms), Math.max(1, ms), handler),
  };

  /** Advances time by `ms`: timers and sleeps that fall due run in order, at their own time. */
  cx.advance = (ms = 0) => {
    const target = cx.now + Math.max(0, ms);
    for (;;) {
      let next = null;
      for (const timer of cx.timers) {
        if (!timer.done && timer.due <= target && (!next || timer.due < next.at)) next = { at: timer.due, timer };
      }
      for (const sleep of cx.sleeps) {
        if (!sleep.done && sleep.due <= target && (!next || sleep.due < next.at)) next = { at: sleep.due, sleep };
      }
      if (!next) break;
      cx.now = Math.max(cx.now, next.at);
      if (next.sleep) {
        next.sleep.done = true;
        next.sleep.resolve();
      } else {
        const timer = next.timer;
        timer.calls++;
        if (timer.repeat) timer.due = cx.now + timer.repeat; else timer.done = true;
        try { timer.handler(cx); } catch (error) { cx.timerErrors.push(error); }
      }
    }
    cx.now = target;
    return cx;
  };

  /** The errors adopted by spawn, for a test that expects none. */
  cx.errors = () => cx.tasks.filter(task => task.error).map(task => task.error);

  return cx;
}

/** Drains queued promise callbacks without waiting on the clock. */
export async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Waits `ms` of real time, for work that needs the OS (a child process, fs). */
export function flushReal(ms = 25) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
