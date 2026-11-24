#!/usr/bin/env node
// acp-view bridge: the ACP *client* for one Claude Code session.
//
//   acp-view mod  <--loopback WebSocket, JSON-->  bridge  <--stdio JSON-RPC (ACP)-->  claude-agent-acp
//
// The bridge owns the agent process and keeps every event it produced, so a
// view that reloads or reconnects gets the whole transcript replayed. It also
// turns pictures (agent image blocks, Mermaid, Markdown image references)
// into files the view can show, and turns ACP diffs into unified patches.
//
// The mod starts it in an hc terminal (see link.js), so the session is an hc
// agent: it reports OSC 7501 status, text typed into the terminal (hc send,
// child notes) becomes a prompt, and Claude's tools inherit HC_TERMINAL_ID,
// so agents it starts with `hc run` are its children (see terminal.mjs).
// Run outside a terminal (no TTY or no HC_TERMINAL_ID), it is view-only as
// before. Diagnostics go to --log.
//
// Usage: node bridge.mjs --cwd DIR --app-home DIR --info FILE [--log FILE] [--resume SESSION_ID] [--idle-ms N]

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { createTwoFilesPatch } from "diff";
import { Assets } from "./assets.mjs";
import { TerminalSide } from "./terminal.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const CWD = args.cwd ?? process.cwd();
const APP_HOME = args["app-home"];
const INFO = args.info;
const IDLE_MS = Number(args["idle-ms"] ?? 30 * 60 * 1000);
// After the last view says it is closing: how long a reloaded view has to come back.
const CLOSE_GRACE_MS = Number(args["close-grace-ms"] ?? 20 * 1000);
if (!APP_HOME || !INFO) {
  console.error("usage: bridge.mjs --cwd DIR --app-home DIR --info FILE [--resume ID]");
  process.exit(2);
}

const logStream = args.log ? createWriteStream(args.log, { flags: "a" }) : process.stderr;
const log = (...a) => logStream.write(`${new Date().toISOString()} ${a.map((x) => (x instanceof Error ? x.stack : typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
const require = createRequire(import.meta.url);
const AGENT_JS = join(dirname(require.resolve("@agentclientprotocol/claude-agent-acp/package.json")), "dist/index.js");
const assets = new Assets(APP_HOME, CWD);

// --- event log + clients ----------------------------------------------------

const history = [];
const clients = new Set();
let seq = 0;
let lastUsage = null;

function emit(ev) {
  ev.seq = ++seq;
  // Coalesce streamed text so a replay is not thousands of tiny messages.
  const last = history.at(-1);
  const u = ev.t === "update" ? ev.update : null;
  const lu = last?.t === "update" ? last.update : null;
  if (u && lu && u.sessionUpdate === lu.sessionUpdate && (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk")
    && u.content?.type === "text" && lu.content?.type === "text" && (u.messageId ?? null) === (lu.messageId ?? null)) {
    lu.content.text += u.content.text;
    last.seq = ev.seq;
  } else if (ev.t === "usage") {
    lastUsage = ev;
  } else if (ev.t !== "working") {
    history.push(ev);
  }
  const text = JSON.stringify(ev);
  for (const ws of clients) ws.send(text);
  if (term) {
    term.show(ev);
    if (ev.t === "update" && ev.update?.sessionUpdate === "session_info_update" && ev.update.title) term.title(`${ev.update.title} · Claude ACP`);
  }
}

// --- the hc terminal side (see terminal.mjs) ----------------------------------------

const HC_ID = process.env.HC_TERMINAL_ID || null;
const term = HC_ID && process.stdin.isTTY && process.stdout.isTTY
  ? new TerminalSide({ onSubmit: (text) => typed(text), onInterrupt: () => cancel() })
  : null;
// Messages typed in while a turn runs (hc notes, reports): sent as the next turn.
const queue = [];

// Waiting on the person: a permission prompt or a question (form elicitation).
const asking = () => permissions.size + questions.size;

function typed(text) {
  if (!sessionId || working || asking()) {
    queue.push(text);
    term?.show({ t: "queued", count: queue.length });
    return;
  }
  prompt({ text });
}

// The next turn from the queue, if it's time for one.
function drain() {
  if (!sessionId || working || asking() || !queue.length) return false;
  prompt({ text: queue.splice(0).join("\n\n") });
  return true;
}

// The 7501 word for where the session is now.
function report() {
  if (!term) return;
  if (permissions.size) {
    const title = [...permissionTitles.values()].at(-1);
    return term.status("blocked", { kind: "permission", msg: title ?? "Permission requested" });
  }
  if (questions.size) {
    const title = [...questions.values()].at(-1).title;
    return term.status("blocked", { kind: "question", msg: title ?? "Claude has a question" });
  }
  term.status(working ? "working" : "idle");
}

// Live hc terminals this one started (Claude's subagents).
function liveChildren() {
  if (!HC_ID) return Promise.resolve(0);
  return new Promise((resolve) => {
    const p = spawn("hc", ["ls", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(0));
    p.on("close", () => {
      try {
        const list = JSON.parse(out).terminals ?? [];
        resolve(list.filter((t) => t.parent === HC_ID && t.state === "live").length);
      } catch {
        resolve(0);
      }
    });
  });
}

// --- agent process + JSON-RPC -------------------------------------------------

// HC_TERMINAL_ID passes through, so Claude's `hc run` makes children of this
// terminal. The marker tells hooks/session-start.sh this isn't a terminal Claude.
const agent = spawn(process.execPath, [AGENT_JS], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERDR_ACP_VIEW_BRIDGE: "1" } });
agent.stderr.on("data", (d) => logStream.write(d));
agent.on("exit", (code, signal) => {
  log("agent exited", code, signal);
  emit({ t: "exit", code, signal });
  for (const [, p] of pending) p.reject(new Error("agent exited"));
  setTimeout(() => shutdown(0), 1500);
});

let nextId = 0;
const pending = new Map();
const permissions = new Map();
const permissionTitles = new Map();
// Open form elicitations (AskUserQuestion, MCP forms): key -> { id, title }.
const questions = new Map();

function request(method, params) {
  const id = ++nextId;
  agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
const notifyAgent = (method, params) => agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const respond = (id, result, error) => agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");

let buf = "";
agent.stdout.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { log("bad line from agent", line.slice(0, 200)); continue; }
    onAgentMessage(m).catch((e) => log("handler failed", e));
  }
});

async function onAgentMessage(m) {
  if (m.id !== undefined && !m.method) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(Object.assign(new Error(m.error.message ?? "agent error"), { data: m.error }));
    else p.resolve(m.result);
    return;
  }
  switch (m.method) {
    case "session/update": {
      const update = await transformUpdate(m.params.update);
      if (update.sessionUpdate === "usage_update") emit({ t: "usage", update });
      else emit({ t: "update", update });
      return;
    }
    case "session/request_permission": {
      permissions.set(String(m.id), m.id);
      permissionTitles.set(String(m.id), m.params.toolCall?.title ?? null);
      report();
      emit({ t: "permission", id: String(m.id), toolCall: await transformToolCall(m.params.toolCall ?? {}), options: m.params.options ?? [] });
      return;
    }
    // AskUserQuestion (and MCP server forms) as an ACP form elicitation. The
    // view draws the form; its answer goes back as the response (see "answer").
    case "elicitation/create": {
      const p = m.params ?? {};
      if (p.mode !== "form" || !p.requestedSchema) {
        respond(m.id, { action: "decline" });
        return;
      }
      questions.set(String(m.id), { id: m.id, title: p.message ?? null });
      report();
      emit({ t: "question", id: String(m.id), toolCallId: p.toolCallId ?? null, message: p.message ?? "", schema: p.requestedSchema });
      return;
    }
    // The agent withdrew a request it sent (an elicitation whose turn ended).
    case "$/cancel_request": {
      const key = String(m.params?.requestId);
      if (questions.delete(key)) {
        emit({ t: "question_done", id: key, action: "cancel" });
        report();
      }
      return;
    }
    default:
      // fs/* and terminal/* are not advertised, so the agent uses its own tools.
      if (m.id !== undefined) respond(m.id, undefined, { code: -32601, message: `method not supported by acp-view: ${m.method}` });
  }
}

// --- transforming agent payloads for the view ------------------------------------

async function transformBlock(block) {
  if (!block || typeof block !== "object") return block;
  if (block.type === "image" && block.data) {
    try {
      const a = await assets.save(Buffer.from(block.data, "base64"), block.mimeType ?? "");
      return { type: "image", mimeType: block.mimeType, ...a };
    } catch (e) {
      return { type: "text", text: `*(image could not be shown: ${e.message})*` };
    }
  }
  if (block.type === "resource" && block.resource?.blob && /^image\//.test(block.resource.mimeType ?? "")) {
    return transformBlock({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
  }
  return block;
}

async function transformToolCall(tc) {
  const out = { ...tc };
  if (out._meta?.claudeCode?.toolResponse) {
    out._meta = { ...out._meta, claudeCode: { ...out._meta.claudeCode } };
    delete out._meta.claudeCode.toolResponse;
  }
  if (typeof out.rawOutput === "string" && out.rawOutput.length > 20000) out.rawOutput = out.rawOutput.slice(0, 20000) + "\n…";
  if (Array.isArray(out.content)) {
    out.content = await Promise.all(out.content.map(async (c) => {
      if (c.type === "content") return { ...c, content: await transformBlock(c.content) };
      if (c.type === "diff") {
        const patch = createTwoFilesPatch(c.path, c.path, c.oldText ?? "", c.newText ?? "", "", "", { context: 3 });
        const lines = patch.split("\n").slice(2);
        const clipped = lines.length > 1500 ? [...lines.slice(0, 1500), `… ${lines.length - 1500} more lines`] : lines;
        return { type: "diff", path: c.path, isNew: c.oldText == null, unified: clipped.join("\n") };
      }
      return c;
    }));
  }
  return out;
}

async function transformUpdate(u) {
  if (u.content && !Array.isArray(u.content)) return { ...u, content: await transformBlock(u.content) };
  if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") return transformToolCall(u);
  return u;
}

// --- session lifecycle -----------------------------------------------------------

let sessionId = null;
let session = null;
let working = 0;

async function start() {
  emit({ t: "status", text: "Starting Claude…" });
  const init = await request("initialize", {
    protocolVersion: 1,
    // Form elicitation lets Claude ask (AskUserQuestion); without it the agent disables the tool.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    clientInfo: { name: "herdr-acp-view", title: "Herdr ACP view", version: "0.1.0" },
  });
  let result = null;
  if (args.resume && init.agentCapabilities?.loadSession) {
    emit({ t: "status", text: "Loading the previous session…" });
    try {
      result = await request("session/load", { sessionId: args.resume, cwd: CWD, mcpServers: [] });
      sessionId = args.resume;
    } catch (e) {
      log("session/load failed", e.message);
      emit({ t: "notice", text: `Could not resume the previous session (${e.message}). Started a new one.` });
    }
  }
  if (!sessionId) {
    result = await request("session/new", { cwd: CWD, mcpServers: [] });
    sessionId = result.sessionId;
  }
  session = { sessionId, cwd: CWD, agent: init.agentInfo ?? null, modes: result?.modes ?? null, models: result?.models ?? null, configOptions: result?.configOptions ?? null };
  emit({ t: "session", ...session });
  // Until now hc counts it as working (it never reported): sends wait for this.
  report();
  drain();
}

async function prompt(msg) {
  if (!sessionId) return;
  const blocks = [];
  const shown = [];
  for (const p of msg.images ?? []) {
    try {
      const data = await readFile(p);
      const a = await assets.save(data, p);
      const mimeType = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[a.path.split(".").pop()];
      if (!mimeType) throw new Error("only PNG, JPEG, GIF and WebP can be sent");
      blocks.push({ type: "image", mimeType, data: data.toString("base64") });
      shown.push(a);
    } catch (e) {
      emit({ t: "notice", text: `Could not attach ${p}: ${e.message}` });
    }
  }
  if (msg.text) blocks.push({ type: "text", text: msg.text });
  if (!blocks.length) return;
  emit({ t: "user", text: msg.text ?? "", images: shown });
  working++;
  emit({ t: "working", working });
  report();
  let failed = null;
  try {
    const r = await request("session/prompt", { sessionId, prompt: blocks });
    emit({ t: "turn_end", stopReason: r?.stopReason ?? "end_turn", usage: r?.usage ?? null });
  } catch (e) {
    failed = e.message;
    emit({ t: "error", text: e.message });
  } finally {
    working--;
    emit({ t: "working", working });
    // Messages that came in during the turn go next, without an idle in between.
    if (!drain()) {
      if (failed && !working && term) term.status("error", { msg: failed });
      else report();
    }
  }
}

// Stops the turn and turns down open permission prompts and questions (Stop, Esc, Ctrl+C).
function cancel() {
  if (sessionId) notifyAgent("session/cancel", { sessionId });
  for (const [key, id] of permissions) {
    respond(id, { outcome: { outcome: "cancelled" } });
    permissions.delete(key);
    permissionTitles.delete(key);
    emit({ t: "permit_done", id: key, optionId: null });
  }
  for (const [key, q] of questions) {
    respond(q.id, { action: "cancel" });
    questions.delete(key);
    emit({ t: "question_done", id: key, action: "cancel" });
  }
  report();
}

async function onClientMessage(ws, msg) {
  switch (msg.t) {
    case "prompt": return prompt(msg);
    case "cancel": return cancel();
    case "permit": {
      const id = permissions.get(String(msg.id));
      if (id === undefined) return;
      permissions.delete(String(msg.id));
      permissionTitles.delete(String(msg.id));
      respond(id, { outcome: msg.optionId ? { outcome: "selected", optionId: msg.optionId } : { outcome: "cancelled" } });
      emit({ t: "permit_done", id: String(msg.id), optionId: msg.optionId ?? null });
      report();
      return;
    }
    // An answer to a question: accept with the form's content, decline (Skip) or cancel.
    case "answer": {
      const key = String(msg.id);
      const q = questions.get(key);
      if (!q) return;
      questions.delete(key);
      const action = ["accept", "decline", "cancel"].includes(msg.action) ? msg.action : "cancel";
      const content = action === "accept" && msg.content && typeof msg.content === "object" ? msg.content : undefined;
      respond(q.id, action === "accept" ? { action, content: content ?? {} } : { action });
      emit({ t: "question_done", id: key, action, ...(content ? { content } : {}) });
      report();
      return;
    }
    case "mode":
      try {
        await request("session/set_mode", { sessionId, modeId: msg.modeId });
        emit({ t: "update", update: { sessionUpdate: "current_mode_update", currentModeId: msg.modeId } });
      } catch (e) {
        emit({ t: "notice", text: `Could not switch mode: ${e.message}` });
      }
      return;
    // A session config option: model, effort (thought_level), Fast mode, …
    // The agent answers with every option, since one can change another
    // (a model switch changes the effort levels on offer).
    case "config":
      if (!sessionId) return;
      try {
        const r = await request("session/set_config_option", { sessionId, configId: msg.configId, value: msg.value });
        if (Array.isArray(r?.configOptions)) emit({ t: "update", update: { sessionUpdate: "config_option_update", configOptions: r.configOptions } });
      } catch (e) {
        emit({ t: "notice", text: `Could not change ${msg.configId}: ${e.message}` });
      }
      return;
    case "render": {
      try {
        const a = msg.kind === "mermaid" ? await assets.mermaid(msg.src, msg.colors) : await assets.file(msg.src);
        ws.send(JSON.stringify({ t: "asset", key: msg.key, ...a }));
      } catch (e) {
        ws.send(JSON.stringify({ t: "asset", key: msg.key, error: String(e.message ?? e) }));
      }
      return;
    }
    case "shutdown": return shutdown(0);
    case "closing": ws.closing = true; return;
  }
}

// --- WebSocket server --------------------------------------------------------------

const token = randomBytes(18).toString("base64url");
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 32 * 1024 * 1024 });
let idleTimer = null;
let closeTimer = null;
const armIdle = () => {
  clearTimeout(idleTimer);
  clearTimeout(closeTimer);
  if (clients.size === 0) idleTimer = setTimeout(async () => {
    // Never walk away from a running turn, an unanswered permission prompt,
    // or subagents (hc ends a terminal's children with it).
    if (working || asking() || queue.length || (await liveChildren())) return armIdle();
    if (clients.size) return;
    log("no view for", IDLE_MS, "ms; exiting");
    shutdown(0);
  }, IDLE_MS);
};

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.searchParams.get("token") !== token) { ws.close(1008, "bad token"); return; }
  // The same pane again: Herdr reloaded the mod, which stops the old build but
  // leaves its socket open. Drop that one, or it would count as a view forever
  // and the bridge would never end after the pane closes.
  ws.view = url.searchParams.get("view");
  if (ws.view) for (const c of clients) {
    if (c.view !== ws.view) continue;
    log("view reconnected; dropping its old connection");
    clients.delete(c);
    c.terminate();
  }
  clients.add(ws);
  log("view connected", ws.view ?? "(no id)", "views:", clients.size);
  armIdle();
  ws.send(JSON.stringify({ t: "hello", sessionId, cwd: CWD, history: lastUsage ? [...history, lastUsage] : history, working, terminal: term ? HC_ID : null }));
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    onClientMessage(ws, msg).catch((e) => log("client message failed", e));
  });
  ws.on("close", () => {
    clients.delete(ws);
    log("view disconnected", ws.view ?? "(no id)", ws.closing ? "(closing)" : "", "views:", clients.size);
    armIdle();
    if (ws.closing && clients.size === 0) {
      log("view closed; ending in", CLOSE_GRACE_MS, "ms unless a view returns");
      // A turn or a permission prompt still running falls back to the idle
      // timer, which waits for it (a pane hidden or closed mid-turn).
      closeTimer = setTimeout(async () => {
        if (clients.size) return;
        if (working || asking() || queue.length) { log("view gone mid-turn; waiting for it"); return armIdle(); }
        // App quit or a reload also closes the view: keep subagents alive.
        const kids = await liveChildren();
        if (kids) { log("view gone with", kids, "live subagents; waiting for them"); return armIdle(); }
        if (clients.size) return;
        shutdown(0);
      }, CLOSE_GRACE_MS);
    }
  });
});

wss.on("listening", async () => {
  const { port } = wss.address();
  const tmp = `${INFO}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ port, token, pid: process.pid, cwd: CWD }));
  await rename(tmp, INFO);
  log("listening on", port, term ? `as hc terminal ${HC_ID}` : "without a terminal");
  if (term) {
    term.start();
    term.title("Claude ACP");
    term.print(`Claude over ACP, as hc terminal ${HC_ID}, in ${CWD}.\nThe rich view is the acp-view pane. Text typed or sent here (hc send ${HC_ID}) is a prompt; Esc stops a turn.`);
  }
  armIdle();
  start().catch((e) => { log("start failed", e); emit({ t: "error", text: `Could not start Claude: ${e.message}` }); });
});

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  term?.stop();
  try { agent.kill("SIGTERM"); } catch {}
  for (const ws of clients) ws.close();
  wss.close();
  await unlink(INFO).catch(() => {});
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("SIGHUP", () => {});
