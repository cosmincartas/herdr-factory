// Starts (or finds) a session's bridge and keeps a WebSocket to it.
//
// The bridge runs in an hc terminal (`hc run --bg`), labeled with this pane's
// space and tab, so Herdr gives it a pane there and lists it in the Agents
// sidebar. That terminal is the session's hc address: agents Claude starts
// with `hc run` are its children and report to it (see bridge/terminal.mjs).
// Its info file holds { pid, port, token }; the mod keeps that file's path in
// its store, so a reload or an app restart finds the running bridge again.

import { WebSocket } from "websocket";
import { exec, hc, appHome, home, readTextFile, spaces } from "herdr";

const reason = (e) => String(e?.message ?? e ?? "failed").replace(/^Error: /, "");

export class Link {
  // onEvent(msg, cx) gets every message from the bridge.
  // resumeOf(): the ACP session id to load, or null; asked at each start.
  // store: where the bridge's info file path is kept (see store.js).
  // shouldStart(): false to stop instead of starting a new bridge when the
  // running one is gone.
  // tab: the pane's tab id; the bridge's terminal gets a pane there.
  // detached: no pane. The terminal gets acp-view.space/acp-view.tab labels
  // instead of Herdr's, so Herdr leaves it alone and the herdr-factory
  // layout's agents list (factory-agents) shows it under that tab.
  constructor({ cwd, tab, detached, store, resumeOf, shouldStart, onEvent, onState }) {
    this.store = store;
    this.cwd = cwd;
    this.tab = tab ?? null;
    this.detached = Boolean(detached);
    this.resumeOf = resumeOf ?? (() => null);
    this.shouldStart = shouldStart ?? (() => true);
    this.onEvent = onEvent;
    this.onState = onState;
    this.ws = null;
    this.stopped = false;
    this.state = "starting";
    this.error = null;
    this.info = this.store.get("bridge-info");
    // This pane's id towards the bridge, kept across reloads. A reload stops the
    // old build without closing its socket, so the bridge drops an older
    // connection with the same id instead of counting it as a second view.
    this.viewId = this.store.get("view-id");
    if (!this.viewId) {
      this.viewId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.store.set("view-id", this.viewId);
    }
  }

  start(cx) {
    cx.spawn(async (cx) => this.loop(cx));
    return this;
  }

  set(state, cx, error = null) {
    this.state = state;
    this.error = error;
    this.onState?.(state, cx);
    cx.notify();
  }

  async loop(cx) {
    let backoff = 500;
    let fresh = 0;
    while (!this.stopped) {
      try {
        let addr = this.info ? await this.read(this.info) : null;
        if (!addr) {
          if (!this.shouldStart()) { this.stopped = true; this.set("ended", cx); break; }
          if (fresh++ > 3) throw new Error("the bridge did not start; see ~/.local/state/herdr-acp-view/*.log");
          this.set("starting", cx);
          this.info = await this.spawn();
          this.store.set("bridge-info", this.info);
          addr = await this.waitFor(this.info, cx);
        }
        this.ws = await WebSocket.connect(`ws://127.0.0.1:${addr.port}/?token=${addr.token}&view=${encodeURIComponent(this.viewId)}`);
        if (this.stopped) break;
        this.set("live", cx);
        backoff = 500;
        fresh = 0;
        for (;;) {
          const text = await this.ws.read();
          if (this.stopped) break;
          if (typeof text !== "string") continue;
          let msg;
          try { msg = JSON.parse(text); } catch { continue; }
          this.onEvent(msg, cx);
          cx.notify();
        }
      } catch (e) {
        if (this.stopped) break;
        this.ws = null;
        // A dead bridge leaves its info file behind only after a crash.
        if (this.info && !(await this.alive(this.info))) this.info = null;
        this.set("error", cx, reason(e));
        await cx.sleep(backoff);
        backoff = Math.min(backoff * 2, 8000);
      }
    }
  }

  async read(info) {
    const text = await readTextFile(info).catch(() => null);
    if (!text) return null;
    try {
      const a = JSON.parse(text);
      return (await this.pidAlive(a.pid)) ? a : null;
    } catch {
      return null;
    }
  }

  async alive(info) {
    return Boolean(await this.read(info));
  }

  async pidAlive(pid) {
    const r = await exec("kill", ["-0", String(pid)]).catch(() => ({ code: 1 }));
    return r.code === 0;
  }

  async spawn() {
    const state = `${home()}/.local/state/herdr-acp-view`;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const info = `${state}/${id}.json`;
    const log = `${state}/${id}.log`;
    const dir = `${appHome()}/mods/acp-view/bridge`;
    // Dependencies once, and node's absolute path for the detached start.
    const prep = await exec("sh", ["-c", [
      'mkdir -p "$1" && cd "$2" || exit 1',
      '[ -d node_modules ] || npm install --silent --no-fund --no-audit >>"$3" 2>&1 || exit 1',
      "command -v node",
    ].join("\n"), "sh", state, dir, log], { timeout: 180000 });
    const node = prep.stdout.trim().split("\n").pop();
    if (prep.code !== 0 || !node) throw new Error(prep.stderr.trim() || "node or the bridge's dependencies are missing");

    const argv = [`${dir}/bridge.mjs`, "--cwd", this.cwd, "--app-home", appHome(), "--info", info, "--log", log];
    const resume = this.resumeOf();
    if (resume) argv.push("--resume", resume);
    // In an hc terminal of its own, so the session has an hc address. With the
    // tab's Herdr labels, it gets a pane in this tab and shows in the Agents list.
    const labels = ["--label", `acp-view=${id}`];
    const space = this.tab ? spaces().find((s) => s.tabs.some((t) => t.id === this.tab)) : null;
    const ns = this.detached ? "acp-view" : "herdr";
    if (space && !space.machine) labels.push("--label", `${ns}.space=${space.id}`, "--label", `${ns}.tab=${this.tab}`);
    const r = await hc(["run", "--bg", "--json", "--no-parent", "--cwd", this.cwd, ...labels, "--", node, ...argv]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "the bridge did not start");
    try { this.store.set("bridge-terminal", JSON.parse(r.stdout).address ?? null); } catch {}
    return info;
  }

  async waitFor(info, cx) {
    for (let i = 0; i < 150; i++) {
      const a = await this.read(info);
      if (a) return a;
      await cx.sleep(200);
    }
    throw new Error("the bridge did not start in 30 s");
  }

  send(msg) {
    if (!this.ws) return false;
    this.ws.write(JSON.stringify(msg)).catch(() => {});
    return true;
  }

  // Ends the bridge (and Claude with it) and waits for it to exit, so the
  // session's transcript is complete before anyone else resumes it.
  async shutdown() {
    this.stopped = true;
    const info = this.info;
    this.info = null;
    this.store.set("bridge-info", null);
    try { this.send({ t: "shutdown" }); } catch {}
    this.ws?.close().catch(() => {});
    this.ws = null;
    if (info) await stopBridge(info);
  }

  // This view is going away: the bridge ends unless a view reconnects soon.
  close() {
    this.stopped = true;
    try { this.send({ t: "closing" }); } catch {}
    this.ws?.close().catch(() => {});
    this.ws = null;
  }

  // Leaves the bridge running (a reload, a hidden pane).
  detach() {
    this.stopped = true;
    this.ws?.close().catch(() => {});
    this.ws = null;
  }
}

// Stops the bridge behind an info file, by pid, and waits up to 5 s for it to go.
export async function stopBridge(info) {
  const text = await readTextFile(info).catch(() => null);
  let pid = null;
  try { pid = JSON.parse(text ?? "{}").pid ?? null; } catch {}
  if (!pid) return;
  await exec("kill", [String(pid)]).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const r = await exec("kill", ["-0", String(pid)]).catch(() => ({ code: 1 }));
    if (r.code !== 0) return;
    await exec("sleep", ["0.1"]).catch(() => {});
  }
}

// Whether the bridge behind an info file is running.
export async function bridgeAlive(info) {
  if (!info) return false;
  const text = await readTextFile(info).catch(() => null);
  let pid = null;
  try { pid = JSON.parse(text ?? "{}").pid ?? null; } catch {}
  if (!pid) return false;
  const r = await exec("kill", ["-0", String(pid)]).catch(() => ({ code: 1 }));
  return r.code === 0;
}
