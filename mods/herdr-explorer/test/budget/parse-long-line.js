// Budget scenario: a long matching line parses inside the host's init budget (C-1b).
//
// `sh test/budget.sh parse-long-line` installs this file as the mod's main.js, with the real one
// renamed to explorer.js. In init it parses one 3.7 MB ASCII line with 40,000 submatches and one
// 300 KB non-ASCII line with 3,000 through search.js, then seeds a one-row tree so render() has
// something to draw. The host's uncatchable interrupt is the oracle: exit 1 with "interrupted"
// means the parse is over the ~500 ms init budget.
import Explorer from "./explorer.js";
import * as search from "./search.js";

const NEEDLE = "needle";
const MAX_MATCHES = 2000;

// ---- today's parse, for the RED run ----
//
// search.js gains parseMatches in Task 1. Before that the same work runs in searchContent and
// walks the line from its start for every submatch, which is quadratic: this copy reproduces it
// so the RED run really is interrupted rather than failing on a missing export. Unused once
// search.js exports parseMatches.
function byteToIndex(text, byte) {
  let bytes = 0, i = 0;
  while (i < text.length && bytes < byte) {
    const c = text.codePointAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    i += c >= 0x10000 ? 2 : 1;
  }
  return i;
}

function legacyParse(stdout) {
  const files = new Map();
  let total = 0, truncated = false;
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (!line.startsWith('{"type":"match"')) continue;
    if (total >= MAX_MATCHES) { truncated = true; break; }
    let data;
    try { data = JSON.parse(line).data; } catch { continue; }
    const path = data.path?.text, raw = data.lines?.text;
    if (!path || raw === undefined) continue;
    const text = raw.replace(/\r?\n$/, "");
    const ranges = (data.submatches ?? []).map(s => [byteToIndex(text, s.start), byteToIndex(text, s.end)]);
    const rel = path.startsWith("./") ? path.slice(2) : path;
    if (!files.has(rel)) files.set(rel, { path: rel, matches: [] });
    const col = [...text.slice(0, ranges[0]?.[0] ?? 0)].length + 1;
    files.get(rel).matches.push({ line: data.line_number, col, text, ranges });
    total++;
  }
  if (lines.length >= MAX_MATCHES * 3) truncated = true;
  return { files: [...files.values()], total, truncated };
}

const parse = typeof search.parseMatches === "function" ? search.parseMatches : legacyParse;

// ---- fixtures ----

const TEXT = "lorem ipsum dolor sit amet, consectetur adipiscing elit. sed do eiusmod tempor incididunt ut labore. ";

/** An ASCII line of `count` blocks, each `unit` bytes: filler then NEEDLE. */
function asciiLine(count, unit) {
  const filler = TEXT.slice(0, unit - NEEDLE.length);
  const parts = [], submatches = [];
  for (let i = 0; i < count; i++) {
    parts.push(filler);
    const start = i * unit + filler.length;
    submatches.push({ match: { text: NEEDLE }, start, end: start + NEEDLE.length });
    parts.push(NEEDLE);
  }
  return { line: parts.join(""), submatches, col: filler.length + 1 };
}

// "aé漢🙂x " is 12 bytes and 6 characters, so byte and character columns differ.
const WIDE_FILLER = "aé漢🙂x ".repeat(7) + "0123456789"; // 94 bytes, 52 characters

/** A non-ASCII line of `count` blocks, each `unit` bytes: the wide filler then NEEDLE. */
function wideLine(count, unit) {
  const parts = [], submatches = [];
  for (let i = 0; i < count; i++) {
    parts.push(WIDE_FILLER);
    const start = i * unit + 94; // WIDE_FILLER's UTF-8 length
    submatches.push({ match: { text: NEEDLE }, start, end: start + NEEDLE.length });
    parts.push(NEEDLE);
  }
  return { line: parts.join(""), submatches, col: [...WIDE_FILLER].length + 1 };
}

function record(path, line, submatches) {
  return JSON.stringify({ type: "match", data: {
    path: { text: `./${path}` }, lines: { text: `${line}\n` },
    line_number: 1, absolute_offset: 0, submatches,
  } });
}

function check(name, result, col) {
  const m = result.files[0]?.matches[0];
  if (result.total !== 1 || result.files.length !== 1 || !m) throw new Error(`${name}: no match parsed`);
  if (m.col !== col) throw new Error(`${name}: col ${m.col}, expected ${col}`);
  if (m.text.length > 500) throw new Error(`${name}: stored ${m.text.length} characters, over 500`);
  if (!m.ranges.length) throw new Error(`${name}: no ranges kept`);
  for (const [s, e] of m.ranges) {
    if (s < 0 || e > m.text.length || m.text.slice(s, e) !== NEEDLE) throw new Error(`${name}: bad range ${s}-${e}`);
  }
}

/** A row whose column waits for opening: the preview still keeps the source around the match. */
function checkDeferred(name, result, line) {
  const m = result.files[0]?.matches[0];
  if (result.total !== 1 || !m) throw new Error(`${name}: no match parsed`);
  if (m.text.length > 500) throw new Error(`${name}: stored ${m.text.length} characters, over 500`);
  if (m.text !== line.slice(line.length - m.text.length)) throw new Error(`${name}: the stored preview is not a slice of the line`);
  const [s, e] = m.ranges[0] ?? [];
  if (m.text.slice(s, e) !== NEEDLE) throw new Error(`${name}: the stored preview lost the match`);
  // The row's own rule is 26 characters before the match, so the stored window must hold them.
  if (!(s >= 26)) throw new Error(`${name}: the stored preview kept ${s} characters before the match`);
  // Deliberately not resolving the exact column here: it is a character count over the whole line
  // (about 243 ms per 3.7 MB in QuickJS), the cost this shape exists to keep out of the parse.
  // C-1a asserts that opening the row gives rg's exact column.
}

export default class ParseLongLine extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    const ascii = asciiLine(40_000, 92); // 3.68 MB, 40,000 submatches
    const wide = wideLine(3_000, 100);   // 300 KB, 3,000 submatches
    check("ascii", parse(record("big.txt", ascii.line, ascii.submatches)), ascii.col);
    check("wide", parse(record("wide.txt", wide.line, wide.submatches)), wide.col);

    // 3.7 MB of non-ASCII: the two shapes that used to walk the whole line before returning.
    const blocks = 39_300, prefixBytes = 94 * blocks;
    const prefix = WIDE_FILLER.repeat(blocks); // 3.69 MB
    const late = prefix + NEEDLE;              // first (only) match at the very end
    checkDeferred("late", parse(record("late.txt", late, [
      { match: { text: NEEDLE }, start: prefixBytes, end: prefixBytes + NEEDLE.length },
    ])), late);
    const far = NEEDLE + prefix + NEEDLE;      // early match, second one 3.69 MB later
    check("far", parse(record("far.txt", far, [
      { match: { text: NEEDLE }, start: 0, end: NEEDLE.length },
      { match: { text: NEEDLE }, start: NEEDLE.length + prefixBytes, end: NEEDLE.length + prefixBytes + NEEDLE.length },
    ])), 1);

    this.root = "/tmp/herdr-explorer-budget/parse-long-line";
    this.gen = 1;
    this.entries = new Map([["", [{ name: "file-00.js", dir: false }]]]);
    this.cursor = "file-00.js";
  }
}
