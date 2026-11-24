// Port-forwarding core: URL classification, SSH machine lookup, and the
// labeled `ssh -N -L` herdr-core terminal that forwards one local port.
//
// This module imports nothing. Mods cannot load in Node, so the core performs
// every effect through injected Deps (spec "Interfaces or Classes") and
// node --test can run it with fakes at the process boundary.

/**
 * One herdr-core or process result.
 * @typedef {{ code: number, stdout: string, stderr: string }} ExecResult
 */

/**
 * The effects the core performs, provided by link.js, main.js and the tests.
 * @typedef {{
 *   hc: (args: string[]) => Promise<ExecResult>,
 *   exec: (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>,
 *   notify: (n: { level: "error", title: string, body: string }) => unknown,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 * }} Deps
 */

/** How often the readiness loop looks at the terminal and the port. */
const POLL_MS = 250;
/** How long a forward has to listen before it is given up on. */
const READY_DEADLINE_MS = 20_000;
/** How long xdg-open may take, leaving room under Herdr's 30 s handler limit. */
const OPEN_TIMEOUT_MS = 5_000;

/** The loopback hosts a click may name (spec "Link rule"). */
const LOOPBACK_HOST = /^(https?):\/\/(\[::1\]|localhost|127\.0\.0\.1|0\.0\.0\.0):([0-9]+)(?:[/?#]|$)/i;

/**
 * Classify a clicked URL.
 * @returns {{ remoteHost: string, port: number, openUrl: string } | null}
 */
export function forwardTarget(url) {
  if (typeof url !== "string") return null;
  const match = LOOPBACK_HOST.exec(url);
  if (!match) return null;
  const port = toPort(match[3]);
  if (port === null) return null;
  const host = match[2].toLowerCase();
  // A server that binds 0.0.0.0 is reached over loopback, so ssh forwards there.
  const remoteHost = host === "0.0.0.0" ? "localhost" : host;
  const openUrl = host === "0.0.0.0" ? url.replace(/^(https?:\/\/)0\.0\.0\.0/i, "$1localhost") : url;
  return { remoteHost, port, openUrl };
}

/**
 * The dialog's form as a ForwardRequest (FR-7). Ports come before the machine so
 * that each invalid form reports the field F-8 names for it.
 * @returns {{ ok: true, request: object } | { ok: false, error: string }}
 */
export function parseForwardForm(form) {
  const remotePort = toPort(String(form?.remotePort ?? "").trim());
  if (remotePort === null) {
    return { ok: false, error: "Remote port must be a number from 1 to 65535" };
  }
  const localText = String(form?.localPort ?? "").trim();
  const localPort = localText === "" ? remotePort : toPort(localText);
  if (localPort === null) {
    return { ok: false, error: "Local port must be a number from 1 to 65535" };
  }
  const machine = String(form?.machine ?? "").trim();
  if (machine === "") return { ok: false, error: "Choose a machine" };
  return { ok: true, request: { machine, remoteHost: "localhost", remotePort, localPort } };
}

/**
 * The machines whose ports can be forwarded: SSH machines with a usable target.
 * @param {Deps} deps
 * @returns {Promise<{ name: string, target: string }[]>}
 */
export async function sshMachines(deps) {
  const result = await deps.hc(["machine", "ls", "--json"]);
  if (result.code !== 0) throw new Error(reasonOf(result, "hc machine ls failed"));
  const machines = parseJson(result.stdout)?.machines ?? [];
  return machines
    .filter((machine) => machine && machine.via === false && isTarget(machine.target))
    .map((machine) => ({ name: String(machine.name), target: machine.target }));
}

/**
 * Reuse a ready forward for a request, or start and wait for one.
 * @param {object} request
 * @param {Deps} deps
 * @returns {Promise<{ ok: true, forward: object, reused: boolean } | { ok: false, reason: string }>}
 */
export async function ensureForward(request, deps) {
  // F-1 and F-11: resolve the SSH eligibility before reuse or conflict checks.
  const target = await sshTarget(request.machine, deps);
  if (!target) return { ok: false, reason: notSshReason(request.machine) };

  const existing = await findForward(request.localPort, deps);
  if (existing) return await reuseForward(existing, request, deps);

  if (await portListened(request.localPort, deps)) {
    // The winner of a concurrent start may have listed its terminal by now.
    const owned = await findForward(request.localPort, deps);
    if (owned) return await reuseForward(owned, request, deps);
    return { ok: false, reason: `Local port ${request.localPort} is already in use on this computer` };
  }

  const started = await startForward(request, target, deps);
  if (!started.ok) {
    // A concurrent click may have taken the terminal name just before this run.
    let concurrent = null;
    try {
      concurrent = await findForward(request.localPort, deps);
    } catch {
      // F-11: the recheck failed, so keep the reason this request already has.
    }
    if (concurrent) return await reuseForward(concurrent, request, deps);
    return { ok: false, reason: started.reason };
  }

  return await awaitReady(request, started.address, deps, true);
}

/**
 * Every live local forward, sorted by local port. `hc ls` already drops dead
 * terminals; a remote address is not this computer's forward.
 * @param {Deps} deps
 * @returns {Promise<object[]>} `Forward[]`
 */
export async function listForwards(deps) {
  const result = await deps.hc(["ls", "--json", "--label", "port-forward=1"]);
  if (result.code !== 0) throw new Error(reasonOf(result, "hc ls failed"));
  const forwards = [];
  for (const terminal of parseJson(result.stdout)?.terminals ?? []) {
    if (!isLocalAddress(terminal.address)) continue;
    const info = await terminalInfo(terminal.address, deps);
    if (!info || (info.state && info.state !== "live")) continue;
    const forward = forwardFromLabels(terminal.address, info.labels ?? {});
    if (forward) forwards.push(forward);
  }
  return forwards.sort((a, b) => a.localPort - b.localPort);
}

/**
 * Kill a local forward's terminal, then remove it.
 * @param {string} address
 * @param {Deps} deps
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function stopForward(address, deps) {
  if (!isLocalAddress(address)) {
    return { ok: false, reason: `${address} isn't a local terminal address` };
  }
  try {
    const killed = await deps.hc(["kill", address]);
    if (killed.code !== 0) return { ok: false, reason: stderrOf(killed, "hc kill failed") };
    const removed = await deps.hc(["rm", address]);
    if (removed.code !== 0) return { ok: false, reason: reasonOf(removed, "hc rm failed") };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
}

/**
 * A Ctrl+click on a loopback URL printed on a remote machine.
 * @param {object} click
 * @param {Deps} deps
 * @returns {Promise<"handled" | "pass">}
 */
export async function handleClick(click, deps) {
  const url = click?.link?.kind === "url" ? click.link.url : null;
  const target = forwardTarget(url);
  const machine = click?.source?.machine ?? null;
  // A local terminal, or a URL Herdr should open itself.
  if (!target || !machine) return "pass";

  try {
    // Click step 2: resolve the SSH target before any reuse or conflict logic.
    const ssh = await sshTarget(machine, deps);
    if (!ssh) {
      notifyError(deps, `Couldn't forward port ${target.port}`, notSshReason(machine));
      return "handled";
    }
    const result = await ensureForward(
      { machine, remoteHost: target.remoteHost, remotePort: target.port, localPort: target.port },
      deps,
    );
    if (!result.ok) {
      notifyError(deps, `Couldn't forward port ${target.port}`, result.reason);
      return "handled";
    }
    const opened = await openInBrowser(target.openUrl, deps);
    if (!opened.ok) {
      notifyError(deps, `Couldn't open ${target.openUrl}`, `The forward is ready, but xdg-open failed: ${opened.reason}`);
    }
    return "handled";
  } catch (e) {
    notifyError(deps, `Couldn't forward port ${target.port}`, messageOf(e));
    return "handled";
  }
}

/** UI-2: one error notification per failed click. */
function notifyError(deps, title, body) {
  deps.notify({ level: "error", title, body });
}

/** Open the forwarded URL within the click's budget; either way the forward stays. */
async function openInBrowser(url, deps) {
  let result;
  try {
    result = await deps.exec("xdg-open", [url], { timeout: OPEN_TIMEOUT_MS });
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
  if (result.code === 0) return { ok: true };
  return { ok: false, reason: String(result.stderr ?? "").trim() || "xdg-open failed" };
}

/** The [Forward start command](spec) argv for one request and SSH target. */
function forwardArgv(request, target) {
  const labels = [
    ["port-forward", "1"],
    ["port-forward.machine", request.machine],
    ["port-forward.local", String(request.localPort)],
    ["port-forward.host", request.remoteHost],
    ["port-forward.remote", String(request.remotePort)],
  ];
  return [
    "run", "--bg", "--json", "--no-parent", "--name", terminalName(request.localPort),
    ...labels.flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    "--", "ssh", "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-L", `localhost:${request.localPort}:${request.remoteHost}:${request.remotePort}`,
    target,
  ];
}

/** The terminal name that guards a local port (`hc run --name` is unique live). */
const terminalName = (localPort) => `port-forward-${localPort}`;

/** The live local forward on a local port, or null. */
async function findForward(localPort, deps) {
  const result = await deps.hc([
    "ls", "--json", "--label", "port-forward=1", "--label", `port-forward.local=${localPort}`,
  ]);
  if (result.code !== 0) throw new Error(reasonOf(result, "hc ls failed"));
  for (const terminal of parseJson(result.stdout)?.terminals ?? []) {
    if (!isLocalAddress(terminal.address)) continue;
    const info = await terminalInfo(terminal.address, deps);
    if (!info || (info.state && info.state !== "live")) continue;
    const forward = forwardFromLabels(terminal.address, info.labels ?? {});
    if (forward && forward.localPort === localPort) return forward;
  }
  return null;
}

/** Reuse a matching forward once it listens; a conflict fails with F-2. */
async function reuseForward(existing, request, deps) {
  const same =
    existing.machine === request.machine &&
    existing.remoteHost === request.remoteHost &&
    existing.remotePort === request.remotePort;
  if (!same) {
    return {
      ok: false,
      reason: `Local port ${request.localPort} already forwards to ${existing.machine}:${existing.remoteHost}:${existing.remotePort}`,
    };
  }
  // A joining click never owns the terminal, so it never kills or removes it.
  return await awaitReady(request, existing.address, deps, false);
}

/**
 * Poll the terminal and the port until the forward listens, fails or times out.
 * The deadline is checked before a listener is accepted, so a slow poll cannot
 * turn a late listener into success.
 */
async function awaitReady(request, address, deps, owner) {
  const deadline = deps.now() + READY_DEADLINE_MS;
  for (;;) {
    await deps.sleep(POLL_MS);
    const inspection = await inspectTerminal(address, deps);
    if (!inspection.ok) {
      // R-05: an inspection error is not a confirmed ssh exit.
      if (owner) return await failAfterStart(address, inspection.reason, false, deps);
      return { ok: false, reason: inspection.reason };
    }
    if (inspection.info.state !== "live") {
      // Nothing can listen through a forward whose ssh has gone.
      const reason = await exitReason(address, deps);
      if (owner) return await failAfterStart(address, reason, true, deps);
      return { ok: false, reason };
    }
    const listened = await portListened(request.localPort, deps);
    if (deps.now() >= deadline) {
      const reason = `ssh did not start listening on port ${request.localPort} within 20 s`;
      if (owner) return await failAfterStart(address, reason, false, deps);
      return { ok: false, reason };
    }
    if (listened) return { ok: true, forward: { ...request, address }, reused: !owner };
  }
}

/**
 * Clean up a terminal this request started, keeping the original failure reason.
 * A confirmed exit needs only removal; a live or unknown state is killed first.
 */
async function failAfterStart(address, reason, exited, deps) {
  const cleanup = exited ? await removeTerminal(address, deps) : await killAndRemove(address, deps);
  return cleanup.ok ? { ok: false, reason } : { ok: false, reason, cleanupError: cleanup.reason };
}

/** `hc rm` with its outcome checked. */
async function removeTerminal(address, deps) {
  try {
    const result = await deps.hc(["rm", address]);
    if (result.code !== 0) return { ok: false, reason: reasonOf(result, "hc rm failed") };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
}

/** `hc kill` then `hc rm`, checking each outcome even when the first fails. */
async function killAndRemove(address, deps) {
  const errors = [];
  try {
    const killed = await deps.hc(["kill", address]);
    if (killed.code !== 0) errors.push(stderrOf(killed, "hc kill failed"));
  } catch (e) {
    errors.push(messageOf(e));
  }
  try {
    const removed = await deps.hc(["rm", address]);
    if (removed.code !== 0) errors.push(reasonOf(removed, "hc rm failed"));
  } catch (e) {
    errors.push(messageOf(e));
  }
  return errors.length ? { ok: false, reason: errors.join("; ") } : { ok: true };
}

/** A Forward from a terminal's [Forward labels](spec), or null when they are incomplete. */
function forwardFromLabels(address, labels) {
  if (labels["port-forward"] !== "1") return null;
  const localPort = toPort(labels["port-forward.local"]);
  const remotePort = toPort(labels["port-forward.remote"]);
  if (localPort === null || remotePort === null) return null;
  return {
    address,
    machine: String(labels["port-forward.machine"] ?? ""),
    localPort,
    remoteHost: String(labels["port-forward.host"] ?? "localhost"),
    remotePort,
  };
}

/** A port value, from a label or a form field, as an integer from 1 to 65535, or null. */
function toPort(value) {
  const text = String(value ?? "");
  if (!/^[0-9]+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Why a forward's ssh ended: the last non-empty line of its output, or a fallback. */
async function exitReason(address, deps) {
  let output = "";
  try {
    const result = await deps.hc(["read", address]);
    if (result.code === 0) output = String(result.stdout ?? "");
  } catch {
    output = "";
  }
  const last = output.split("\n").map((line) => line.trim()).filter(Boolean).pop();
  return last || "ssh exited";
}

/** The SSH target of a machine name, or null when it cannot be forwarded through. */
async function sshTarget(machine, deps) {
  const machines = await sshMachines(deps);
  return machines.find((candidate) => candidate.name === machine)?.target ?? null;
}

const notSshReason = (machine) => `${machine} isn't an SSH machine, so its ports can't be forwarded`;

/** Whether anything listens on a local port, per `ss -ltnH`. */
async function portListened(port, deps) {
  let result;
  try {
    result = await deps.exec("ss", ["-ltnH", `sport = :${port}`]);
  } catch {
    return false;
  }
  return result.code === 0 && result.stdout.trim() !== "";
}

/** Start the forward terminal. */
async function startForward(request, target, deps) {
  let result;
  try {
    result = await deps.hc(forwardArgv(request, target));
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
  if (result.code !== 0) return { ok: false, reason: reasonOf(result, "hc run failed") };
  const address = parseJson(result.stdout)?.address;
  if (typeof address !== "string" || address === "") {
    return { ok: false, reason: "hc run printed no terminal address" };
  }
  return { ok: true, address };
}

/** `hc get <address> --json` for scans, or null when the terminal cannot be inspected. */
async function terminalInfo(address, deps) {
  const inspection = await inspectTerminal(address, deps);
  return inspection.ok ? inspection.info : null;
}

/** `hc get <address> --json`, distinguishing a confirmed terminal from a failed lookup. */
async function inspectTerminal(address, deps) {
  let result;
  try {
    result = await deps.hc(["get", address, "--json"]);
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
  if (result.code !== 0) return { ok: false, reason: reasonOf(result, "hc get failed") };
  const info = parseJson(result.stdout);
  if (!info || typeof info !== "object") {
    return { ok: false, reason: "hc get printed no terminal" };
  }
  return { ok: true, info };
}

/** A bare local herdr-core terminal address; a federated one is `machine/tN`. */
const isLocalAddress = (address) =>
  typeof address === "string" && address !== "" && !address.includes("/");

const isTarget = (target) =>
  typeof target === "string" && target !== "" && !target.startsWith("-");

const parseJson = (text) => {
  try {
    return JSON.parse(text || "");
  } catch {
    return null;
  }
};

const messageOf = (e) => String(e?.message ?? e ?? "failed");

/** The reason a failed hc result carries: stderr, then stdout, then a fallback. */
function reasonOf(result, fallback) {
  const stderr = String(result?.stderr ?? "").trim();
  if (stderr) return stderr;
  const stdout = String(result?.stdout ?? "").trim();
  return stdout || fallback;
}

/** F-9's reason: stderr, or exactly the fallback when stderr is empty. */
function stderrOf(result, fallback) {
  return String(result?.stderr ?? "").trim() || fallback;
}
