// A long matching line stays cheap to parse (P1, C-1a).
//
// rg --json reports UTF-8 byte offsets and ignores --max-columns, so one minified line can be
// megabytes long with thousands of submatches. The parse must not walk the line from the start
// for every submatch, must keep only a small window of the line for the row, and must still give
// the exact 1-based character column in the full line — computing it when the row is opened when
// the match sits too far into a non-ASCII line to convert cheaply.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";

import { TEST_THEME, calls, onExec, reset, state } from "herdr";
import { searchContent } from "../search.js";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";
import { callsNamed, resetUi } from "./stubs/ui.mjs";

// parseMatches is the new export this task adds; reach it through the namespace so this file
// still loads (and fails on its timing, not on a link error) before the change.
import * as search from "../search.js";

const parse = stdout => {
  if (typeof search.parseMatches !== "function") throw new Error("search.js does not export parseMatches");
  return search.parseMatches(stdout);
};

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
});

const NEEDLE = "needle";

// One rg --json "match" record for `line`, whose NEEDLE matches are at the given byte offsets.
function rgMatch(path, line, submatches) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: `./${path}` },
      lines: { text: `${line}\n` },
      line_number: 7,
      absolute_offset: 0,
      submatches,
    },
  });
}

const needleAt = (start) => ({ match: { text: NEEDLE }, start, end: start + NEEDLE.length });

/**
 * Real `rg --json` output for one file holding `text`; `argv` is rg's own pattern and flags. rg is
 * the mod's own dependency, and the offsets it reports (CRLF line ends, byte offsets into UTF-8)
 * cannot be invented by hand for these cases.
 */
function rgJson(name, text, argv) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-search-"));
  try {
    writeFileSync(join(dir, name), text);
    return execFileSync("rg", ["--no-config", "--json", ...argv, name], { cwd: dir, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The longest string reachable from `value`: a parsed row should hold its preview and nothing more. */
function longestString(value, seen = new Set()) {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let longest = 0;
  for (const inner of Object.values(value)) longest = Math.max(longest, longestString(inner, seen));
  return longest;
}

/** An ASCII line of about `bytes` characters holding `count` NEEDLE matches, spread evenly. */
function asciiFixture(bytes, count) {
  const unit = Math.max(NEEDLE.length + 1, Math.floor(bytes / count));
  const filler = "lorem ipsum dolor sit amet ".repeat(3).slice(0, unit - NEEDLE.length)
    .padEnd(unit - NEEDLE.length, "x");
  const parts = [];
  const submatches = [];
  let at = 0;
  while (at < bytes) {
    parts.push(filler);
    at += filler.length;
    submatches.push(needleAt(at));
    parts.push(NEEDLE);
    at += NEEDLE.length;
  }
  return { line: parts.join(""), submatches, first: submatches[0].start };
}

// "aé漢🙂x " is 12 bytes, 7 UTF-16 units and 6 characters: byte, unit and character columns differ.
const WIDE = "aé漢🙂x ";
const BYTES_PER_WIDE = 12, CHARS_PER_WIDE = 6;

const OPTS = { caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "" };

/** `fn`'s result, plus how often it read a code point: the walk a bounded parse must not make. */
function countingCodePointAt(fn) {
  const original = String.prototype.codePointAt;
  let count = 0;
  String.prototype.codePointAt = function (...args) { count++; return original.apply(this, args); };
  try {
    const result = fn();
    return { result, count };
  } finally {
    String.prototype.codePointAt = original;
  }
}

// ---- opening a result row (the keyboard path: activate -> openFile) ----

function seededExplorer(result) {
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = "/repo";
  explorer.view = "search";
  explorer.results = result;
  explorer.ssel = 1;  // row 0 is the file, row 1 its first match
  return { explorer, cx };
}

/** The path opening the selected search row hands Helix. */
async function openedPath(result) {
  const { explorer, cx } = seededExplorer(result);
  explorer.activate("search", true, cx);
  await flush();
  return calls.run.find(call => call.name === "terminal.open")?.args.argv[1] ?? null;
}

// ---- resultRow's rendered text (the UI stubs record it) ----

/** The parts of a result row's text: { text, lit }, where `lit` is a highlighted range. */
function renderedParts(row) {
  const { explorer } = seededExplorer({ files: [], total: 0, truncated: false });
  resetUi();
  explorer.resultRow({ kind: "match", path: "src/big.txt", ...row }, 0, TEST_THEME, true);
  return callsNamed("children").pop().args[0].map(el => ({
    text: el.calls.find(call => call.name === "child" && typeof call.args[0] === "string")?.args[0] ?? "",
    lit: el.calls.some(call => call.name === "bg"),
  }));
}

const rendered = row => renderedParts(row).map(part => part.text).join("");

test("searchContent: a 363 KB line with 4,000 submatches parses in under 200 ms", async () => {
  const { line, submatches, first } = asciiFixture(363_000, 4_000);
  assert.ok(submatches.length >= 4_000);
  onExec("sh", () => ({ code: 0, stdout: rgMatch("big.txt", line, submatches), stderr: "" }));

  const started = performance.now();
  const result = await searchContent("/repo", null, NEEDLE, OPTS);
  const elapsed = performance.now() - started;

  // The timing is the point of the check: report it before anything else can fail.
  assert.ok(elapsed < 200, `long line parsed in ${Math.round(elapsed)} ms (budget 200 ms)`);

  // --max-columns is a no-op under --json (rg 15), so the parse no longer asks for it.
  const argv = calls.exec[0].args.join(" ");
  assert.ok(!argv.includes("--max-columns"), "searchContent still passes --max-columns, which --json ignores");

  assert.equal(result.total, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, "big.txt");
  const m = result.files[0].matches[0];
  assert.equal(m.line, 7);
  assert.equal(m.col, first + 1);
  assert.ok(m.text.length <= 500, `stored text is ${m.text.length} characters, over the 500 limit`);
  assert.ok(m.text.length < line.length);
  assert.ok(m.ranges.length > 0);
  for (const [s, e] of m.ranges) {
    assert.ok(s >= 0 && e <= m.text.length, `range ${s}-${e} lies outside the stored window`);
    assert.equal(m.text.slice(s, e), NEEDLE, "a stored range does not cover its matched text");
  }
});

test("parseMatches: the preview keeps the first match and the row its 26 characters before it", () => {
  const { line, submatches, first } = asciiFixture(363_000, 4_000);
  const m = parse(rgMatch("big.txt", line, submatches)).files[0].matches[0];

  assert.ok(m.text.length <= 500);
  // Derived from the fixture: the stored text is one slice of the line, the first match sitting
  // at `first` there, and some range covers that match.
  assert.equal(m.col, first + 1);
  const range = m.ranges[0];
  const windowStart = first - range[0];
  assert.equal(m.text, line.slice(windowStart, windowStart + m.text.length), "the preview is not a slice of the line");
  assert.equal(m.text.slice(range[0], range[1]), NEEDLE);
  for (const [s, e] of m.ranges) assert.ok(s >= 0 && e <= m.text.length);

  // The plan's rendering rule: at most 26 characters before the match, with an ellipsis.
  const shown = rendered(m);
  const context = "…" + line.slice(first - 26, first) + NEEDLE;
  assert.ok(shown.startsWith(context), `row shows ${JSON.stringify(shown.slice(0, 32))}, expected it to start with ${JSON.stringify(context)}`);
});

test("parseMatches: col counts characters of the full line, not bytes or UTF-16 units", () => {
  // "é" is one character but two bytes; the needle starts at byte 100, character 51.
  const accented = "é".repeat(50) + NEEDLE;
  const accentedStart = Buffer.byteLength("é".repeat(50));
  const accentedRow = parse(rgMatch("accented.txt", accented, [needleAt(accentedStart)])).files[0].matches[0];
  assert.equal(accentedRow.col, 51);
  assert.equal(accentedRow.text.slice(accentedRow.ranges[0][0], accentedRow.ranges[0][1]), NEEDLE);

  // An emoji is one character, two UTF-16 units and four bytes: it is the 21st column.
  const emoji = "🙂".repeat(20) + NEEDLE;
  const emojiStart = Buffer.byteLength("🙂".repeat(20));
  const emojiRow = parse(rgMatch("emoji.txt", emoji, [needleAt(emojiStart)])).files[0].matches[0];
  assert.equal(emojiRow.col, 21);
  assert.equal(emojiRow.text.slice(emojiRow.ranges[0][0], emojiRow.ranges[0][1]), NEEDLE);
});

test("parseMatches: a late first match in a 3.7 MB non-ASCII line does not walk it", async () => {
  const blocks = 308_350;  // 3.7 MB of non-ASCII, the match only at its end
  const prefix = WIDE.repeat(blocks);
  const line = prefix + NEEDLE;
  const subs = [needleAt(blocks * BYTES_PER_WIDE)];

  const { result, count } = countingCodePointAt(() => parse(rgMatch("late.txt", line, subs)));
  const m = result.files[0].matches[0];

  // Conversion is bounded to the preview: the line before the match is not walked at all.
  assert.ok(count < 4096, `the parse read ${count} code points, walking the line past the preview`);
  assert.ok(m.text.length <= 500, `stored text is ${m.text.length} characters, over the 500 limit`);
  assert.ok(m.text.includes(NEEDLE), "the stored preview lost the match");
  assert.equal(m.ranges.length, 1);
  assert.equal(m.text.slice(m.ranges[0][0], m.ranges[0][1]), NEEDLE);
  // The window is around the match, so it holds the source before it (the 26-character rule).
  assert.ok(m.ranges[0][0] > 0, "the stored preview lost the source before the match");
  assert.equal(m.text, line.slice(line.length - m.text.length), "the preview is not a slice of the line");

  // The exact column counts the characters before the match, and is worked out on opening.
  const expected = blocks * CHARS_PER_WIDE + 1;
  assert.equal(await openedPath(result), `/repo/late.txt:7:${expected}`);
  assert.equal(await openedPath(result), `/repo/late.txt:7:${expected}`, "opening a row twice should be stable");
});

test("parseMatches: an early match with a distant second match walks only the preview", () => {
  const blocks = 308_350;  // 3.7 MB between the first match and the second
  const prefix = WIDE.repeat(blocks);
  const line = NEEDLE + prefix + NEEDLE;
  const subs = [needleAt(0), needleAt(NEEDLE.length + blocks * BYTES_PER_WIDE)];

  const { result, count } = countingCodePointAt(() => parse(rgMatch("far.txt", line, subs)));
  const m = result.files[0].matches[0];

  // The second match is beyond the stored window, so converting it is never started.
  assert.ok(count < 4096, `the parse read ${count} code points, past the stored window`);
  assert.equal(m.col, 1);
  assert.deepEqual(m.ranges, [[0, NEEDLE.length]]);
  assert.equal(m.text.slice(0, NEEDLE.length), NEEDLE);
  assert.ok(m.text.length <= 500);
});

test("parseMatches: the eager cutoff — a prefix of thousands of ASCII characters after one é", async () => {
  // The first non-ASCII character is at the line's start, the match 8,190 bytes in: converting the
  // prefix one character at a time is 8,189 reads for a 66-unit preview. It is measured in chunks
  // instead, and the row keeps the same window around the match (the exact column waits for
  // opening, where it costs one walk).
  const head = "é" + "x".repeat(8_188);
  const line = head + NEEDLE;
  const first = head.length;  // UTF-16 index of the match: é is one character and two bytes

  const { result, count } = countingCodePointAt(() => parse(rgMatch("cut.txt", line, [needleAt(8_190)])));
  const m = result.files[0].matches[0];
  assert.ok(count < 2048, `the parse read ${count} code points for an 8 KB prefix`);
  // The preview is still one slice of the line around the match, with context before it.
  const [s, e] = m.ranges[0];
  assert.equal(m.text.slice(s, e), NEEDLE);
  assert.ok(s >= 26, `the preview kept only ${s} characters before the match`);
  assert.equal(m.text.slice(s - 26, s), line.slice(first - 26, first));
  assert.equal(m.text, line.slice(first - s, first - s + m.text.length));
  assert.ok(rendered(m).startsWith("…" + line.slice(first - 26, first) + NEEDLE));

  // 200 such lines in one search: the cost stays per stored window, not per prefix character.
  const many = Array.from({ length: 200 }, () => rgMatch("cut.txt", line, [needleAt(8_190)])).join("\n");
  const bulk = countingCodePointAt(() => parse(many));
  assert.equal(bulk.result.total, 200);
  assert.ok(bulk.count < 200 * 2048, `200 such lines read ${bulk.count} code points`);

  // Opening the row still gives rg's exact column, computed there.
  assert.equal(await openedPath(result), `/repo/cut.txt:7:${first + 1}`);
});

test("parseMatches: a deep row keeps its source context and every highlight in the window", async () => {
  // rg's own offsets: `é` is two bytes, so a match 9,000 characters in starts at byte 9,002.
  const head = "é" + "x".repeat(9_000);
  const line = head + "needle needle";
  const result = parse(rgJson("deep.txt", line + "\n", ["--fixed-strings", "-e", NEEDLE]));
  const m = result.files[0].matches[0];
  const first = head.length;

  assert.ok(m.text.length <= 500, `stored text is ${m.text.length} characters, over the 500 limit`);
  // The stored text is one slice of the line with the source before the first match, and the
  // second match — which also fits the window — keeps its highlight.
  const [first0, firstEnd] = m.ranges[0];
  assert.equal(m.text, line.slice(first - first0, first - first0 + m.text.length));
  assert.equal(m.text.slice(first0, firstEnd), NEEDLE);
  assert.ok(first0 >= 26, `the preview kept only ${first0} characters before the match`);
  assert.equal(m.text.slice(first0 - 26, first0), line.slice(first - 26, first));
  assert.equal(m.ranges.length, 2, "the second match fits the window and must keep its highlight");
  assert.equal(m.text.slice(m.ranges[1][0], m.ranges[1][1]), NEEDLE);
  const lit = renderedParts(m).filter(part => part.lit).map(part => part.text);
  assert.deepEqual(lit, [NEEDLE, NEEDLE], "the row lost a highlight that fits the window");

  // The plan's rendering rule still holds on this window, and the column is exact on opening.
  assert.ok(rendered(m).startsWith("…" + line.slice(first - 26, first) + NEEDLE));
  assert.equal(await openedPath(result), `/repo/deep.txt:1:${first + 1}`);
});

test("opening a deep row releases the full line it held for the column", async () => {
  const head = "é" + "x".repeat(9_000);
  const line = head + NEEDLE;
  const result = parse(rgMatch("deep.txt", line, [needleAt(9_002)]));
  const m = result.files[0].matches[0];

  assert.equal(await openedPath(result), `/repo/deep.txt:7:${head.length + 1}`);
  // Only the stored preview is left: the 9,000-character source the column needed is gone.
  assert.ok(longestString(m) <= 500, `the parsed row still holds a string of ${longestString(m)} characters`);
});

test("parseMatches: a deep zero-width match still renders like the full-line row", () => {
  // A regex `$` at the end of a 16.8 KB non-ASCII line: rg reports [16800, 16800].
  const line = WIDE.repeat(1_400);
  const m = parse(rgJson("deep-eol.txt", line + "\n", ["-e", "$"])).files[0].matches[0];

  assert.ok(m.text.length <= 500);
  assert.ok(m.text.isWellFormed());
  assert.equal(m.ranges.length, 1);
  assert.equal(m.ranges[0][0], m.ranges[0][1], "the anchor is not zero-width");
  // The pristine parser stored the whole line with the anchor at its end; the row must look the same.
  const baseline = rendered({ line: 1, col: line.length + 1, text: line, ranges: [[line.length, line.length]] });
  assert.equal(rendered(m), baseline);
  assert.ok(rendered(m).endsWith(line.slice(-26)));
});

test("parseMatches: a CRLF line's end-of-line anchor lands on the stripped text", () => {
  // rg's default (LF) matching puts `$` before the \n: byte 131 on a CRLF line of 130 characters.
  const line = "x".repeat(130);
  const crlf = parse(rgJson("crlf.txt", line + "\r\n", ["-e", "$"])).files[0].matches[0];
  const lf = parse(rgJson("lf.txt", line + "\n", ["-e", "$"])).files[0].matches[0];

  // Pristine columns: 131 for both, and a zero-width range at the line's end in both.
  assert.equal(crlf.col, 131);
  assert.equal(lf.col, 131);
  for (const m of [crlf, lf]) {
    assert.ok(m.text.length <= 500);
    assert.equal(m.ranges.length, 1, "the anchor was dropped");
    assert.equal(m.ranges[0][0], m.ranges[0][1], "the anchor is not zero-width");
    assert.equal(m.text, line.slice(line.length - m.text.length), "the preview is not the end of the line");
    assert.equal(m.text.length - m.ranges[0][0], 0, "the anchor is not at the stored line's end");
  }
  // The pristine parser stored the whole line with ranges [[130, 130]]; the row must look the same.
  const baseline = rendered({ line: 1, col: 131, text: line, ranges: [[130, 130]] });
  assert.equal(rendered(crlf), baseline);
  assert.equal(rendered(lf), baseline);
});

test("parseMatches: a match crossing the preview keeps its visible part", () => {
  // rg reports `a.*z` as one range covering the whole line.
  const line = "a" + "x".repeat(700) + "z";
  const m = parse(rgMatch("span.txt", line, [{ match: { text: line }, start: 0, end: line.length }]))
    .files[0].matches[0];

  assert.equal(m.col, 1);
  assert.ok(m.text.length <= 500, `stored text is ${m.text.length} characters, over the 500 limit`);
  assert.equal(m.text, line.slice(0, m.text.length), "the preview is not a slice of the line");
  // The part of the match the preview holds is highlighted, not dropped.
  assert.deepEqual(m.ranges, [[0, m.text.length]]);
  const lit = renderedParts(m).filter(part => part.lit).map(part => part.text).join("");
  assert.equal(lit, line.slice(0, m.text.length));
});

test("parseMatches: a zero-width end-of-line match keeps the row's 26-character context", () => {
  // A regex `$` on a 130-character line: rg reports [130, 130].
  const line = "x".repeat(130);
  const m = parse(rgMatch("eol.txt", line, [{ match: { text: "" }, start: 130, end: 130 }]))
    .files[0].matches[0];

  assert.ok(m.text.length <= 500);
  assert.equal(m.ranges.length, 1);
  assert.equal(m.ranges[0][0], m.ranges[0][1], "the anchor is not zero-width");
  assert.equal(m.ranges[0][0], m.text.length, "the anchor is not at the stored line's end");

  // Today's parser stores the whole line; the row must look the same.
  const baseline = rendered({ line: 7, col: 131, text: line, ranges: [[130, 130]] });
  assert.equal(rendered(m), baseline);
  assert.ok(rendered(m).endsWith(line.slice(-26)));
});

test("parseMatches: preview cut points never split a surrogate pair", () => {
  // An emoji where the 500-unit preview would end: keeping the high surrogate alone is malformed.
  const tail = NEEDLE + "x".repeat(493) + "🙂Z";
  const a = parse(rgMatch("tail.txt", tail, [needleAt(0)])).files[0].matches[0];
  assert.ok(a.text.isWellFormed(), "the stored text holds a lone surrogate");
  assert.ok(a.text.length <= 500);
  assert.equal(a.text, tail.slice(0, a.text.length));
  assert.equal(a.text.slice(a.ranges[0][0], a.ranges[0][1]), NEEDLE);

  // An emoji just before the characters kept ahead of the match: the same rule at the other cut.
  // It is 4 bytes and 2 UTF-16 units, so the match starts at byte 63 and character 61.
  const head = "🙂" + "x".repeat(59) + NEEDLE;
  const b = parse(rgMatch("head.txt", head, [needleAt(4 + 59)])).files[0].matches[0];
  assert.ok(b.text.isWellFormed(), "the stored text holds a lone surrogate");
  assert.equal(b.col, 61);
  assert.equal(b.text.slice(b.ranges[0][0], b.ranges[0][1]), NEEDLE);
});

test("parseMatches: short lines are kept whole, as before", () => {
  const line = "const value = 42;";
  const result = parse(rgMatch("src/ascii.js", line, [
    { match: { text: "value" }, start: 6, end: 11 },
  ]));
  assert.deepEqual(result, {
    files: [{
      path: "src/ascii.js",
      matches: [{ line: 7, col: 7, text: line, ranges: [[6, 11]] }],
    }],
    total: 1,
    truncated: false,
  });
});
