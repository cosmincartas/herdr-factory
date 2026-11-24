// Find files (fuzzy over the checkout's file list) and content search (ripgrep),
// modelled on Orca's: rg --files / rg --json, hidden files in, .git out, .gitignore respected.
import { exec } from "herdr";

export const MAX_FILES = 50000, MAX_FILE_RESULTS = 200, MAX_MATCHES = 2000;

/** Every file under `root` (relative paths), .gitignore respected, hidden files included. */
export async function listFiles(root, on) {
  const rg = 'rg --files --no-config --null --hidden --glob "!.git" . 2>/dev/null | head -z -n ' + MAX_FILES;
  const find = 'find . -name .git -prune -o -type f -print0 2>/dev/null | head -z -n ' + MAX_FILES;
  const r = await exec("sh", ["-c", `if command -v rg >/dev/null 2>&1; then ${rg}; else ${find}; fi`], { cwd: root, on, timeout: 15000 });
  return r.stdout.split("\0").filter(Boolean).map(p => (p.startsWith("./") ? p.slice(2) : p));
}

const BOUNDARY = new Set(["/", "_", "-", ".", " "]);

// One query against one path: matched positions (into the path) and a score, or null.
// Prefers a match inside the file name, then matches at word starts and runs of letters.
function match(q, path, lower) {
  const base = path.lastIndexOf("/") + 1;
  const attempt = start => {
    const hits = [];
    let j = start;
    for (const c of q) {
      j = lower.indexOf(c, j);
      if (j < 0) return null;
      hits.push(j++);
    }
    return hits;
  };
  const hits = attempt(base) ?? attempt(0);
  if (!hits) return null;
  let score = hits[0] >= base ? 40 : 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i], prev = path[h - 1];
    if (h === base || prev === undefined || BOUNDARY.has(prev) || (prev === prev.toLowerCase() && path[h] !== path[h].toLowerCase())) score += 8;
    if (i && hits[i - 1] === h - 1) score += 5;
    else if (i) score -= Math.min(5, (h - hits[i - 1]) / 4);
  }
  return { hits, score: score - path.length / 20 };
}

/** The best files for `query`: [{ path, hits }], best first. Spaces in the query are ignored. */
export function findFiles(query, paths, limit = MAX_FILE_RESULTS) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return [];
  const out = [];
  for (const path of paths) {
    const m = match(q, path, path.toLowerCase());
    if (m) out.push({ path, hits: m.hits, score: m.score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

// "*.ts, src/**" -> ["*.ts", "src/**"]
const globs = text => (text ?? "").split(",").map(s => s.trim()).filter(Boolean);

// rg reports byte offsets into UTF-8; JavaScript strings index UTF-16 units.
function byteToIndex(text, byte) {
  let bytes = 0, i = 0;
  while (i < text.length && bytes < byte) {
    const c = text.codePointAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    i += c >= 0x10000 ? 2 : 1;
  }
  return i;
}

/**
 * Searches file contents under `root`.
 * opts: { caseSensitive, wholeWord, regex, include, exclude }.
 * Resolves with { files: [{ path, matches: [{ line, col, text, ranges: [[start, end]] }] }], total, truncated }.
 */
export async function searchContent(root, on, query, opts) {
  const args = ["--no-config", "--json", "--hidden", "--glob", "!.git", "--max-filesize", "5M",
    "--max-columns", "400", "--max-columns-preview", "--max-count", "200"];
  if (!opts.caseSensitive) args.push("--ignore-case");
  if (opts.wholeWord) args.push("--word-regexp");
  if (!opts.regex) args.push("--fixed-strings");
  for (const g of globs(opts.include)) args.push("--glob", g);
  for (const g of globs(opts.exclude)) args.push("--glob", `!${g}`);
  args.push("--", query, ".");
  // head bounds the output (rg stops on the closed pipe); 3 lines per match covers begin/end records.
  const r = await exec("sh", ["-c", `rg "$@" | head -n ${MAX_MATCHES * 3}`, "rg", ...args], { cwd: root, on, timeout: 15000 });
  const files = new Map();
  let total = 0, truncated = false;
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith('{"type":"match"')) continue;
    if (total >= MAX_MATCHES) { truncated = true; break; }
    let data;
    try { data = JSON.parse(line).data; } catch { continue; }
    const path = data.path?.text, raw = data.lines?.text;
    if (!path || raw === undefined) continue;  // not UTF-8
    const text = raw.replace(/\r?\n$/, "");
    const ranges = (data.submatches ?? []).map(s => [byteToIndex(text, s.start), byteToIndex(text, s.end)]);
    const rel = path.startsWith("./") ? path.slice(2) : path;
    if (!files.has(rel)) files.set(rel, { path: rel, matches: [] });
    // Helix's columns count characters, not UTF-16 units (an emoji is one, not two).
    const col = [...text.slice(0, ranges[0]?.[0] ?? 0)].length + 1;
    files.get(rel).matches.push({ line: data.line_number, col, text, ranges });
    total++;
  }
  if (!total && r.stderr.trim()) throw new Error(r.stderr.trim().split("\n").pop());
  if (r.stdout.split("\n").length >= MAX_MATCHES * 3) truncated = true;
  return { files: [...files.values()], total, truncated };
}
