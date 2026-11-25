// Scenario-driven fakes for the port-forward core.
//
// The core performs every effect through Deps (spec "Interfaces or Classes").
// These fakes answer the herdr-core shapes from the spec ("herdr-core commands
// consumed") and the Linux tools the core runs, record every call, and advance
// a fake clock whenever the core sleeps. No process runs.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_PATH = fileURLToPath(new URL("../../mods/port-forward/forward.js", import.meta.url));

/** Load one required export, or say which piece of the core is missing. */
export async function loadCore(exportName) {
  if (!existsSync(CORE_PATH)) throw new Error(`port-forward core missing: ${exportName}`);
  const core = await import(pathToFileURL(CORE_PATH).href);
  if (typeof core[exportName] !== "function") {
    throw new Error(`port-forward core missing: ${exportName}`);
  }
  return core[exportName];
}

/** The machine FR-1 forwards through. */
export const sshMachine = { name: "framework", target: "cosmincartas@framework", via: false, state: "ready" };

/** The forward labels of spec "Forward labels". */
export function forwardLabels({ machine = "framework", local, host = "localhost", remote = local }) {
  return {
    "port-forward": "1",
    "port-forward.machine": machine,
    "port-forward.local": String(local),
    "port-forward.host": host,
    "port-forward.remote": String(remote),
  };
}

/** The FR-1 click: a loopback URL printed on a remote machine. */
export function urlClick(port, { path = "/app", machine = "framework" } = {}) {
  return {
    link: { kind: "url", url: `http://localhost:${port}${path}` },
    source: { machine },
  };
}

const okJson = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

/** Every `hc run` argv the core recorded. */
export const runCalls = (calls) => calls.hc.filter((args) => args[0] === "run");

/** The argv of the program `hc run` starts, after its `--`. */
export const sshArgvOf = (runArgs) => runArgs.slice(runArgs.indexOf("--") + 1);

/** The `--label k=v` filters in an `hc` argv. */
function labelPairs(args) {
  const pairs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--label" || typeof args[i + 1] !== "string") continue;
    const at = args[i + 1].indexOf("=");
    pairs.push([args[i + 1].slice(0, at), args[i + 1].slice(at + 1)]);
  }
  return pairs;
}

/**
 * A fake Deps.
 *
 * scenario:
 *   machines: `hc machine ls --json` machines.
 *   machineLs: `{code, stderr, rejects}` for `hc machine ls`.
 *   terminals: `{address, labels, state, exit_code, output, appearsAfter}`; a terminal
 *     with `appearsAfter: "run-attempt"` is hidden until an `hc run` is attempted,
 *     and one with `appearsAfter: "ss-check"` is hidden until `ss` has been run.
 *   listening: ports `ss` lists before anything else happens.
 *   listenAfterRun: list the started forward's local port once `hc run` succeeds.
 *   listenAfterPolls: list a port once `ss` has been called this many times.
 *   listenAtMs: list a port once the fake clock reaches this many milliseconds.
 *   ssLatencyMs: keep the fake clock busy this long inside each `ss` after a run.
 *   lsFailure: `{code, stderr, rejects}` for every labeled `hc ls`.
 *   lsFailureAfterRun: the same, but only after an `hc run` is attempted.
 *   get: `{code, stderr, rejects}` for `hc get` of a terminal that exists.
 *   run: `{code, stderr, address, rejects}` for `hc run`; a successful run starts a
 *     terminal at `address` (default `t9`), or `started: {state, output}` overrides it.
 *   started: `{state, output}` of the terminal a successful `hc run` starts.
 *   kill: `{code, stderr}` for `hc kill`; nonzero leaves the terminal live.
 *   rm: `{code, stderr, rejects}` for `hc rm`.
 *   open: `{code, stderr, rejects}` for `xdg-open`.
 */
export function makeFakeDeps(scenario = {}) {
  const calls = { hc: [], exec: [], notify: [], sleep: [] };
  const clock = { now: 0 };
  const terminals = new Map();
  const listening = new Set(scenario.listening ?? []);
  let runAttempts = 0;
  let ssCalls = 0;

  const start = (terminal) => {
    terminals.set(terminal.address, { state: "live", exit_code: 0, output: "", labels: {}, ...terminal });
  };
  for (const terminal of scenario.terminals ?? []) start(terminal);

  const visible = (terminal) => {
    if (terminal.appearsAfter === "run-attempt" && runAttempts === 0) return false;
    if (terminal.appearsAfter === "ss-check" && ssCalls === 0) return false;
    return true;
  };

  /** A `{code, stderr, rejects}` scenario entry as a failure, or null for success. */
  const failureOf = (spec) => {
    if (!spec) return null;
    if (spec.rejects) throw new Error(String(spec.rejects));
    const code = spec.code ?? 1;
    if (code === 0) return null;
    return { code, stdout: spec.stdout ?? "", stderr: spec.stderr ?? "" };
  };

  const hc = async (args) => {
    calls.hc.push(args);
    const [command, subcommand] = args;
    if (command === "machine" && subcommand === "ls") {
      const failure = failureOf(scenario.machineLs);
      if (failure) return failure;
      return okJson({ machines: scenario.machines ?? [] });
    }
    if (command === "ls") {
      const failure =
        failureOf(runAttempts > 0 ? scenario.lsFailureAfterRun : null) ?? failureOf(scenario.lsFailure);
      if (failure) return failure;
      const filters = labelPairs(args);
      const listed = [...terminals.values()]
        .filter((terminal) => visible(terminal))
        .filter((terminal) => filters.every(([key, value]) => terminal.labels[key] === value));
      return okJson({ terminals: listed.map(({ address, state }) => ({ address, state })) });
    }
    if (command === "get") {
      const terminal = terminals.get(args[1]);
      if (!terminal || !visible(terminal)) return { code: 1, stdout: "", stderr: "no such terminal" };
      const failure = failureOf(scenario.get);
      if (failure) return failure;
      return okJson({
        address: terminal.address,
        labels: terminal.labels,
        state: terminal.state,
        exit_code: terminal.exit_code,
      });
    }
    if (command === "read") {
      const terminal = terminals.get(args[1]);
      if (!terminal) return { code: 1, stdout: "", stderr: "no such terminal" };
      return { code: 0, stdout: terminal.output, stderr: "" };
    }
    if (command === "run") {
      runAttempts += 1;
      if (scenario.run?.rejects) throw new Error(scenario.run.rejects);
      const code = scenario.run?.code ?? 0;
      if (code !== 0) return { code, stdout: "", stderr: scenario.run?.stderr ?? "" };
      const address = scenario.run?.address ?? "t9";
      const labels = Object.fromEntries(labelPairs(args));
      start({ address, labels, ...(scenario.started ?? {}) });
      if (scenario.listenAfterRun) listening.add(Number(labels["port-forward.local"]));
      return okJson({ address });
    }
    if (command === "kill") {
      if (scenario.kill && scenario.kill.code !== 0) {
        return { code: scenario.kill.code, stdout: "", stderr: scenario.kill.stderr ?? "" };
      }
      const terminal = terminals.get(args[1]);
      if (!terminal) return { code: 1, stdout: "", stderr: "no such terminal" };
      terminal.state = "exited";
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "rm") {
      const failure = failureOf(scenario.rm);
      if (failure) return failure;
      terminals.delete(args[1]);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const exec = async (command, args = [], options) => {
    calls.exec.push({ command, args, options });
    if (command === "ss") {
      ssCalls += 1;
      if (runAttempts > 0) clock.now += scenario.ssLatencyMs ?? 0;
      const port = Number(String(args[1] ?? "").replace(/^sport = :/, ""));
      if (scenario.listenAfterPolls !== undefined && ssCalls >= scenario.listenAfterPolls) {
        listening.add(port);
      }
      if (scenario.listenAtMs !== undefined && clock.now >= scenario.listenAtMs) {
        listening.add(port);
      }
      if (!listening.has(port)) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*\n`, stderr: "" };
    }
    if (command === "xdg-open") {
      if (scenario.open?.rejects) throw new Error(scenario.open.rejects);
      const code = scenario.open?.code ?? 0;
      return { code, stdout: "", stderr: code === 0 ? "" : (scenario.open?.stderr ?? "") };
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  const deps = {
    hc,
    exec,
    notify: (notification) => {
      calls.notify.push(notification);
    },
    sleep: async (ms) => {
      calls.sleep.push(ms);
      clock.now += ms;
    },
    now: () => clock.now,
  };

  return { deps, calls, clock, terminals };
}
