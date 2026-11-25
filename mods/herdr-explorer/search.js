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
// A greedy match for a query is a prefix of the greedy match for any extension of it, so a
// longer query can only match paths the shorter one matched too (see findFiles).
function match(qs, path, lower) {
  const base = path.lastIndexOf("/") + 1;
  let hits = null;
  for (let start = base; ; start = 0) {
    const found = [];
    let j = start, i = 0;
    while (i < qs.length) {
      j = lower.indexOf(qs[i], j);
      if (j < 0) break;
      found.push(j++);
      i++;
    }
    if (i === qs.length) { hits = found; break; }
    if (start === 0) break;
  }
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

/** The lowercased file list, computed once per list instead of once per keystroke. */
const loweredLists = new WeakMap();
function lowerOf(paths) {
  let lower = loweredLists.get(paths);
  if (!lower || lower.length !== paths.length) {
    lower = new Array(paths.length);
    for (let i = 0; i < paths.length; i++) lower[i] = paths[i].toLowerCase();
    loweredLists.set(paths, lower);
  }
  return lower;
}

/** Each file list's last query and every path index it matched, to narrow the next query. */
const previousQueries = new WeakMap();

/** What the last findFiles call examined, and whether it narrowed from the previous query. */
export const findStats = { examined: 0, narrowed: false };

// Best first: score, then the shorter path, then code-unit order (localeCompare is not for hot paths).
function rank(a, b) {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.path.length !== b.path.length) return a.path.length < b.path.length ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// The best `limit` without sorting every match: a worst-first heap, so heap[0] is the one a better
// match replaces. siftUp and siftDown keep the worse of two matches on top (rank > 0 means "worse").
function siftUp(heap, i) {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (rank(heap[i], heap[p]) <= 0) break;
    const moved = heap[i]; heap[i] = heap[p]; heap[p] = moved;
    i = p;
  }
}

function siftDown(heap, i) {
  for (;;) {
    const l = 2 * i + 1;
    let worst = i;
    if (l < heap.length && rank(heap[l], heap[worst]) > 0) worst = l;
    if (l + 1 < heap.length && rank(heap[l + 1], heap[worst]) > 0) worst = l + 1;
    if (worst === i) break;
    const moved = heap[i]; heap[i] = heap[worst]; heap[worst] = moved;
    i = worst;
  }
}

/** Adds `item` to the `limit` best kept so far. */
function keep(heap, item, limit) {
  if (heap.length < limit) {
    heap.push(item);
    siftUp(heap, heap.length - 1);
  } else if (limit > 0 && rank(item, heap[0]) < 0) {
    heap[0] = item;
    siftDown(heap, 0);
  }
}

/** The best files for `query`: [{ path, hits }], best first. Spaces in the query are ignored. */
export function findFiles(query, paths, limit = MAX_FILE_RESULTS) {
  const q = query.toLowerCase().replace(/\s+/g, "");
  findStats.narrowed = false;
  findStats.examined = 0;
  if (!q) return [];
  const lower = lowerOf(paths);
  // Match by code point, as before: indexing the query by UTF-16 unit lets a surrogate half pair
  // with half of an unrelated character. One array per keystroke, not one per path.
  const qs = [];
  for (const c of q) qs.push(c);
  // A query that extends the previous one over the same file list can match only its matches.
  const last = previousQueries.get(paths);
  const pool = last && last.query.length < q.length && q.startsWith(last.query) ? last.candidates : null;
  const count = pool ? pool.length : paths.length;
  findStats.narrowed = Boolean(pool);
  findStats.examined = count;
  const best = [], candidates = [];
  for (let n = 0; n < count; n++) {
    const i = pool ? pool[n] : n;
    const m = match(qs, paths[i], lower[i]);
    if (!m) continue;
    candidates.push(i);
    keep(best, { path: paths[i], hits: m.hits, score: m.score }, limit);
  }
  previousQueries.set(paths, { query: q, candidates });
  best.sort(rank);
  return best;
}

// "*.ts, src/**" -> ["*.ts", "src/**"]
const globs = text => (text ?? "").split(",").map(s => s.trim()).filter(Boolean);

// A search row keeps at most this many characters of a matching line: a window around the first
// match, with the ranges shifted into it. A 3.7 MB line would otherwise be row text for render.
const WINDOW = 500, LEAD = 60;
const NON_ASCII = /[^\x00-\x7f]/;
/**
 * The bytes a non-ASCII row converts one character at a time: its own stored preview. Walking
 * characters costs about 62 ns each in QuickJS (243 ms per 3.7 MB), so a first match further in
 * is located in measured chunks instead and its exact column — a character count over the whole
 * prefix — is left for the row's opening (see `atByte` and `columnOf`).
 */
const EAGER = WINDOW + LEAD;
/** UTF-16 units per chunk when measuring how many bytes came before a match (see `atByte`). */
const CHUNK = 1024;

const utf8Length = c => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);
const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;

/**
 * How many bytes `text` takes in UTF-8. `encodeURIComponent` writes every byte of a non-ASCII
 * character as %XX, so unescaping it back leaves one character per byte; both halves run natively
 * in one pass, where `codePointAt` in a loop is about 40 times slower in QuickJS.
 */
const utf8Bytes = text => unescape(encodeURIComponent(text)).length;

/**
 * The UTF-16 index of `byte`, a UTF-8 byte offset into `text`, and the byte offset reached there
 * (`byte` itself unless it is past the text, which is where a CRLF line's `$` sits). Converting a
 * byte offset means counting every character before it, so the chunks before the offset are
 * measured whole and only the chunk that holds it is walked.
 */
function atByte(text, byte) {
  let units = 0, bytes = 0;
  while (units < text.length) {
    const take = Math.min(CHUNK, text.length - units);
    // A chunk must not end between the halves of a surrogate pair: half a pair is not a character
    // to encode, and `encodeURIComponent` refuses one.
    const end = units + take < text.length && isHighSurrogate(text.charCodeAt(units + take - 1))
      ? units + take + 1 : units + take;
    const chunkBytes = utf8Bytes(text.slice(units, end));
    if (bytes + chunkBytes > byte) break;
    bytes += chunkBytes;
    units = end;
  }
  while (units < text.length && bytes < byte) {
    const c = text.codePointAt(units);
    bytes += utf8Length(c);
    units += c >= 0x10000 ? 2 : 1;
  }
  return { index: units, bytes };
}

/**
 * rg reports byte offsets into UTF-8; JavaScript strings index UTF-16 units. Submatches arrive in
 * order, so one forward cursor serves the whole line (and, when converting, its stored window);
 * an all-ASCII line needs no walk at all (byte offset == index == character column). `start` and
 * `startBytes` put the cursor inside the line, for a window far from its start.
 */
function utf8Cursor(text, start = 0, startBytes = 0) {
  let bytes = startBytes, index = start, chars = 0;
  const step = () => {
    const c = text.codePointAt(index);
    bytes += utf8Length(c);
    index += c >= 0x10000 ? 2 : 1;
    chars++;
  };
  return {
    get bytes() { return bytes; },
    get index() { return index; },
    get chars() { return chars; },
    /** Advances to the character holding `byte`. */
    to(byte) { while (index < text.length && bytes < byte) step(); return this; },
    /** Advances to `unit`, a UTF-16 index. */
    toIndex(unit) { while (index < unit) step(); return this; },
  };
}

/** The window [start, end) in `full`, moved inwards so neither cut point splits a surrogate pair. */
function previewBounds(full, start, end) {
  if (start > 0 && isLowSurrogate(full.charCodeAt(start))) start++;
  if (end < full.length && isLowSurrogate(full.charCodeAt(end))) end--;
  return { start, end: Math.max(start, end) };
}

/**
 * The submatches (byte offsets into `full`) shifted into the window [start, end) and clipped to
 * it, so a match that crosses the window still highlights its visible part. `indexAt` turns a byte
 * offset inside the window into a UTF-16 index and `endByte` is the byte offset of `end`; a
 * submatch at or past `endByte` is skipped without converting it, so no walk passes the window.
 */
function windowRanges(subs, start, end, full, indexAt, endByte) {
  const ranges = [], last = end === full.length;
  for (const s of subs) {
    if (s.start >= endByte) {
      // Only a real zero-width match (a regex `$`) sitting at the line's own end belongs here.
      // On a CRLF line that anchor is reported one byte past the stripped text (rg's `$` matches
      // before the \n, after the \r), which is still the line's end.
      if (last && s.end === s.start) ranges.push([end - start, end - start]);
      break;
    }
    const at = Math.max(indexAt(s.start), start);
    if (s.end > endByte) { ranges.push([at - start, end - start]); break; }
    const to = Math.min(s.end === s.start ? at : indexAt(s.end), end);
    if (to > at || s.end === s.start) ranges.push([at - start, to - start]);
  }
  return ranges;
}

/** One match record's row: { line, col, text, ranges }, with `colAt` when `col` waits for opening. */
function rowFor(data, raw) {
  const full = raw.replace(/\r?\n$/, "");
  const subs = data.submatches ?? [];
  if (!subs.length) return { line: data.line_number, col: 1, text: full.slice(0, WINDOW), ranges: [] };
  if (!NON_ASCII.test(full)) {
    // Byte offset == UTF-16 index == character column, except for the `$` anchor of a CRLF line:
    // it is one byte past the stripped text, which is the line's end.
    const first = Math.min(subs[0].start, full.length);
    const start = Math.max(0, first - LEAD);
    const end = Math.min(full.length, start + WINDOW);
    return { line: data.line_number, col: first + 1, text: full.slice(start, end),
      ranges: windowRanges(subs, start, end, full, byte => byte, end) };
  }
  if (subs[0].start <= EAGER) {
    const cursor = utf8Cursor(full).to(subs[0].start);
    // Helix's columns count characters, not UTF-16 units (an emoji is one, not two).
    const col = cursor.chars + 1;
    const { start, end } = previewBounds(full, Math.max(0, cursor.index - LEAD),
      Math.min(full.length, Math.max(0, cursor.index - LEAD) + WINDOW));
    const endByte = utf8Cursor(full).toIndex(end).bytes;
    const convert = utf8Cursor(full);
    return { line: data.line_number, col, text: full.slice(start, end),
      ranges: windowRanges(subs, start, end, full, byte => convert.to(byte).index, endByte) };
  }
  // Far into a non-ASCII line: the offset is located in measured chunks and the same window kept,
  // while the exact column (a character count over the whole prefix) waits for the row's opening.
  // The line rides along with the row until then, and is released by `columnOf`.
  const at = atByte(full, subs[0].start);
  const { start, end } = previewBounds(full, Math.max(0, at.index - LEAD),
    Math.min(full.length, Math.max(0, at.index - LEAD) + WINDOW));
  const startByte = at.bytes - utf8Bytes(full.slice(start, at.index));
  const endByte = at.bytes + utf8Bytes(full.slice(at.index, end));
  const convert = utf8Cursor(full, start, startByte);
  return { line: data.line_number, col: null, colAt: { text: full, byte: subs[0].start },
    text: full.slice(start, end),
    ranges: windowRanges(subs, start, end, full, byte => convert.to(byte).index, endByte) };
}

/**
 * The exact 1-based character column of a match row, computed on opening it when the parse left
 * it to here (a first match far into a non-ASCII line). Cached on the row's `colAt`.
 */
export function columnOf(match) {
  if (match.col != null) return match.col;
  const at = match.colAt;
  if (!at) return 1;
  if (at.chars === undefined) {
    let bytes = 0, chars = 0, index = 0;
    while (index < at.text.length && bytes < at.byte) {
      const c = at.text.codePointAt(index);
      bytes += utf8Length(c);
      index += c >= 0x10000 ? 2 : 1;
      chars++;
    }
    at.chars = chars;
    at.text = null;  // the count is what opening needed; the whole line need not stay reachable
  }
  return at.chars + 1;
}

/**
 * Parses ripgrep's --json output.
 * Returns { files: [{ path, matches: [{ line, col, text, ranges: [[start, end]] }] }], total, truncated }.
 * `text` is a window of at most WINDOW characters around the first match, `ranges` index into it
 * and cover their matched text (clipped where a match runs past the window), and `col` is the
 * 1-based character column in the full line, or null when `columnOf` resolves it on opening.
 */
export function parseMatches(stdout) {
  const lines = stdout.split("\n");
  const files = new Map();
  let total = 0, truncated = lines.length >= MAX_MATCHES * 3;
  for (const line of lines) {
    if (!line.startsWith('{"type":"match"')) continue;
    if (total >= MAX_MATCHES) { truncated = true; break; }
    let data;
    try { data = JSON.parse(line).data; } catch { continue; }
    const path = data.path?.text, raw = data.lines?.text;
    if (!path || raw === undefined) continue;  // not UTF-8
    const rel = path.startsWith("./") ? path.slice(2) : path;
    if (!files.has(rel)) files.set(rel, { path: rel, matches: [] });
    files.get(rel).matches.push(rowFor(data, raw));
    total++;
  }
  return { files: [...files.values()], total, truncated };
}

/**
 * Searches file contents under `root`.
 * opts: { caseSensitive, wholeWord, regex, include, exclude }.
 * Resolves with { files: [{ path, matches: [{ line, col, text, ranges: [[start, end]] }] }], total, truncated }.
 */
export async function searchContent(root, on, query, opts) {
  // rg 15's --json ignores --max-columns, so a long line arrives whole; parseMatches windows it.
  const args = ["--no-config", "--json", "--hidden", "--glob", "!.git", "--max-filesize", "5M",
    "--max-count", "200"];
  if (!opts.caseSensitive) args.push("--ignore-case");
  if (opts.wholeWord) args.push("--word-regexp");
  if (!opts.regex) args.push("--fixed-strings");
  for (const g of globs(opts.include)) args.push("--glob", g);
  for (const g of globs(opts.exclude)) args.push("--glob", `!${g}`);
  args.push("--", query, ".");
  // head bounds the output (rg stops on the closed pipe); 3 lines per match covers begin/end records.
  const r = await exec("sh", ["-c", `rg "$@" | head -n ${MAX_MATCHES * 3}`, "rg", ...args], { cwd: root, on, timeout: 15000 });
  const result = parseMatches(r.stdout);
  if (!result.total && r.stderr.trim()) throw new Error(r.stderr.trim().split("\n").pop());
  return result;
}
