// Scriptable `herdr` host stub.
//
// Every host call is recorded in `calls` and forwarded to an overridable function in `state`.
// `onExec(matcher, handler)` routes matching exec calls (a command name, a RegExp over the whole
// argv, or a predicate); `useRealExec()` runs exec against this machine's real programs, which
// the listing and CLI tests need.
import { spawn } from "node:child_process";

/** Host calls, in order; the counters count reads for focused/panes/spaces/window/theme/checking. */
export const calls = {
  exec: [], hc: [], run: [], notify: [], readTextFile: [], writeTextFile: [], watchFolder: [],
  focused: 0, panes: 0, spaces: 0, window: 0, theme: 0, checking: 0, nextCommand: 0,
};

/** Outstanding `watchFolder` calls: { path, watch, resolve(paths) }. */
export const watches = [];

const commands = [];       // pushed before a nextCommand call
const commandWaiters = []; // nextCommand calls waiting for pushCommand

const emptyExec = () => ({ code: 0, stdout: "", stderr: "" });

function defaultWatchFolder(path) {
  let settle;
  let done = false;
  const promise = new Promise(resolve => { settle = resolve; });
  const entry = { path, watch: promise, resolve: paths => { if (!done) { done = true; settle(paths); } } };
  promise.cancel = () => entry.resolve([]);
  watches.push(entry);
  return promise;
}

/** The theme a test runs against: every color the mod reads, all #rrggbb. */
export const TEST_THEME = {
  background: "#101010", foreground: "#e0e0e0", surface: "#181818", canvas: "#0c0c0c",
  chrome: "#141414", popover: "#202020", raised: "#1c1c1c", hover: "#282828", selected: "#303030",
  border: "#383838", input: "#121212", muted: "#909090", dim: "#707070", accent: "#4aa3ff",
  accent_foreground: "#ffffff", solid: "#4aa3ff", solid_foreground: "#101010", selection: "#2a3a4a",
  working: "#4aa3ff", blocked: "#ff5555", done: "#50fa7b", idle: "#909090", unknown: "#707070",
  ansi0: "#1c1c1c", ansi1: "#ff5555", ansi2: "#50fa7b", ansi3: "#f1fa8c", ansi4: "#4aa3ff",
  ansi5: "#bd93f9", ansi6: "#8be9fd", ansi7: "#e0e0e0", ansi8: "#707070", ansi9: "#ff7777",
  ansi10: "#70ff90", ansi11: "#fffca0", ansi12: "#70b8ff", ansi13: "#cba9ff", ansi14: "#a0f0ff",
  ansi15: "#ffffff",
};

const defaults = {
  exec: emptyExec,
  readTextFile: () => null,
  writeTextFile: () => null,
  watchFolder: defaultWatchFolder,
  focused: () => null,
  panes: () => [],
  spaces: () => [],
  window: () => ({ platform: "linux", titlebar: "none", buttons: false, maximized: false,
    fullscreen: false, active: true, visible: true }),
  nextCommand: () => new Promise(resolve => {
    const queued = commands.shift();
    if (queued !== undefined) resolve(queued); else commandWaiters.push(resolve);
  }),
  notify: () => "notify-1",
  checking: () => false,
  theme: () => TEST_THEME,
  hc: () => ({ code: 0, stdout: "", stderr: "" }),
  run: () => null,
};

/** Overridable behaviour: `state.focused = () => ({ ... })`. */
export const state = { ...defaults };

const execRoutes = []; // { matcher, handler }

function matches(matcher, command, args, options) {
  if (typeof matcher === "function") return matcher(command, args, options);
  if (matcher instanceof RegExp) return matcher.test([command, ...args].join(" "));
  return matcher === command;
}

/** Routes exec calls: matcher is a command ("git"), a RegExp over command + argv, or a predicate.
 *  The handler gets (command, args, options) and resolves with { code, stdout, stderr }. */
export function onExec(matcher, handler) {
  execRoutes.push({ matcher, handler });
}

/** Runs exec through a real child process instead of a canned answer. */
export function realExec(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    // A child killed by a signal closes with a null code; Herdr reports -1, not success.
    child.on("close", code => resolve({ code: typeof code === "number" ? code : -1, stdout, stderr }));
  });
}

export function useRealExec() {
  state.exec = realExec;
}

/** The next nextCommand() call resolves with `command` (queued until one is waiting). */
export function pushCommand(command) {
  const waiter = commandWaiters.shift();
  if (waiter) waiter(command); else commands.push(command);
}

/** Settles a pending watchFolder call with `paths`. */
export function resolveWatch(path, paths) {
  const entry = watches.filter(w => w.path === path).pop();
  if (entry) entry.resolve(paths);
  return Boolean(entry);
}

/** Back to the defaults, and forget every recorded call and pending watch (a beforeEach). */
export function reset() {
  // Outstanding watches are left pending forever instead of being settled with an empty batch:
  // that would let the previous test's Explorer resume, refresh and re-arm a watch into this
  // test's records. The next test's watchFolder call is the only one it can see.
  watches.length = 0;
  execRoutes.length = 0;
  commands.length = 0;
  commandWaiters.length = 0;
  for (const key of Object.keys(calls)) {
    if (Array.isArray(calls[key])) calls[key].length = 0; else calls[key] = 0;
  }
  Object.assign(state, defaults);
}

// ---- the module `herdr` ----

export async function exec(command, args = [], options = {}) {
  calls.exec.push({ command, args, options });
  for (const route of execRoutes) if (matches(route.matcher, command, args, options)) return route.handler(command, args, options);
  return state.exec(command, args, options);
}

export function hc(args, options) {
  calls.hc.push({ args, options });
  return state.hc(args, options);
}

export function run(name, args) {
  calls.run.push({ name, args });
  return state.run(name, args);
}

export function notify(notification) {
  calls.notify.push(notification);
  return state.notify(notification);
}

export async function readTextFile(path, options) {
  calls.readTextFile.push({ path, options });
  // The host function is async: adopt a synchronous fixture (or the default null) into a promise.
  return state.readTextFile(path, options);
}

export function writeTextFile(path, text, expected) {
  calls.writeTextFile.push({ path, text, expected });
  return state.writeTextFile(path, text, expected);
}

export function watchFolder(path) {
  calls.watchFolder.push(path);
  return state.watchFolder(path);
}

export function focused() {
  calls.focused++;
  return state.focused();
}

export function panes() {
  calls.panes++;
  return state.panes();
}

export function spaces() {
  calls.spaces++;
  return state.spaces();
}

export function window() {
  calls.window++;
  return state.window();
}

export function theme() {
  calls.theme++;
  return state.theme();
}

export function checking() {
  calls.checking++;
  return state.checking();
}

export function nextCommand() {
  calls.nextCommand++;
  return state.nextCommand();
}

// A few more host reads, so later modules and tests can import them.
export function home() { return process.env.HOME ?? "/home/test"; }
export function appHome() { return process.env.HERDR_APP_HOME ?? "/home/test/.config/herdr-app"; }
export function props() { return {}; }
export function shared() { return undefined; }
export function setShared() { return null; }
export function agents() { return []; }
export function terminals() { return []; }
