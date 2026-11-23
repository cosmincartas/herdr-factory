#!/usr/bin/env node
// Lists the Claude Code sessions recorded for a folder, newest first, for the
// acp-view pane's session picker. Prints JSON:
//   [{ id, title, modified, terminal }]
// `terminal` is the hc terminal whose `claude` last recorded that session
// (hooks/session-start.sh), or null. The caller checks if it's still live.
//
// Usage: node sessions.mjs CWD [LIMIT]

import { readdir, stat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const cwd = process.argv[2];
const limit = Number(process.argv[3] ?? 40);
if (!cwd) {
  console.error("usage: sessions.mjs CWD [LIMIT]");
  process.exit(2);
}

const HEAD = 64 * 1024;
const TAIL = 256 * 1024;

// Claude Code names a folder's project directory after its path, with every
// character that isn't a letter or digit replaced by "-".
const dir = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

async function slice(path, size, fromEnd) {
  const fh = await open(path, "r");
  try {
    const { size: total } = await fh.stat();
    const len = Math.min(size, total);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, fromEnd ? total - len : 0);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function lines(text) {
  const out = [];
  for (const l of text.split("\n")) {
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

function userText(o) {
  if (o.type !== "user" || o.isMeta || o.toolUseResult) return null;
  let c = o.message?.content;
  if (Array.isArray(c)) c = c.filter((x) => x?.type === "text").map((x) => x.text).join(" ");
  if (typeof c !== "string") return null;
  c = c.trim();
  // Slash commands, caveats and other wrapped harness text.
  if (!c || c.startsWith("<")) return null;
  return c;
}

async function describe(name) {
  const path = join(dir, name);
  const st = await stat(path);
  if (!st.size) return null;
  const tail = lines(await slice(path, TAIL, true));
  let title = null;
  for (const o of tail) {
    if (o.type === "custom-title" && o.customTitle) title = o.customTitle;
    else if (o.type === "ai-title" && o.aiTitle && !title) title = o.aiTitle;
    else if (o.type === "summary" && o.summary && !title) title = o.summary;
  }
  let first = null;
  if (!title) {
    for (const o of lines(await slice(path, HEAD, false))) {
      first = userText(o);
      if (first) break;
    }
  }
  // A transcript with no conversation in it (only snapshots) has nothing to resume.
  if (!title && !first) return null;
  return { id: name.replace(/\.jsonl$/, ""), title: (title ?? first).replace(/\s+/g, " ").slice(0, 160), modified: st.mtimeMs };
}

async function terminalsBySession() {
  const tdir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "herdr-acp-view", "terminals");
  const map = new Map();
  let names = [];
  try { names = await readdir(tdir); } catch { return map; }
  const recs = await Promise.all(names.filter((n) => n.endsWith(".json")).map(async (n) => {
    try {
      const r = JSON.parse(await readFile(join(tdir, n), "utf8"));
      const { mtimeMs } = await stat(join(tdir, n));
      return { terminal: n.replace(/\.json$/, ""), session: r.session_id, at: mtimeMs };
    } catch {
      return null;
    }
  }));
  // The newest record wins when one session was recorded by two terminals.
  for (const r of recs.filter(Boolean).sort((a, b) => a.at - b.at)) if (r.session) map.set(r.session, r.terminal);
  return map;
}

let names = [];
try {
  names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
} catch {
  console.log("[]");
  process.exit(0);
}
const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
withTime.sort((a, b) => b.t - a.t);
const terms = await terminalsBySession();
const out = [];
for (const { n } of withTime) {
  if (out.length >= limit) break;
  const d = await describe(n).catch(() => null);
  if (d) out.push({ ...d, terminal: terms.get(d.id) ?? null });
}
console.log(JSON.stringify(out));
