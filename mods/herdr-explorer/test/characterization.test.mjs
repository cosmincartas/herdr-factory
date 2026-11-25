// Characterization: what herdr-explorer does today, pinned.
//
// These tests say nothing about how it should behave; they record the current answers so the
// performance changes can prove they kept them. Expected values come from running this code:
// findFiles' ranking and hit positions, searchContent's rows, listFolder's parsing and order,
// gitMarks' marks and dirty folders, and Explorer.rows().
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calls, onExec, realExec, reset, state } from "herdr";
import { findFiles, searchContent } from "../search.js";
import { gitMarks, listFolder } from "../listing.js";
import Explorer from "../main.js";
import { createCx } from "./stubs/cx.mjs";
import { resetUi } from "./stubs/ui.mjs";

beforeEach(() => {
  reset();
  resetUi();
  localStorage.clear();
});

// ---- findFiles ----

// Deliberately mixed: nested folders, matching names, and equal-score equal-length ties.
const CORPUS = [
  "src/main.js",
  "src/search.js",
  "src/listing.js",
  "docs/readme.md",
  "README.md",
  "app/Z.ts",
  "app/a.ts",
  "app/m.ts",
  "src/components/Router.tsx",
  "src/components/router-test.ts",
  "lib/router.js",
  "test/search_test.js",
  "src/util/format-date.js",
  "src/fmt.ts",
];

test("findFiles: a name match scores highest, with hits into the path", () => {
  assert.deepEqual(findFiles("main", CORPUS), [
    { path: "src/main.js", hits: [4, 5, 6, 7], score: 62.45 },
  ]);
});

test("findFiles: zero-width matches and non-matches are left out", () => {
  assert.deepEqual(findFiles("", CORPUS), []);
  assert.deepEqual(findFiles("zzz", CORPUS), []);
});

test("findFiles: equal-score equal-length paths sort by code unit", () => {
  const found = findFiles("app", CORPUS);
  // Task 3 replaced the localeCompare tie break with code-unit order, which puts "app/Z.ts" first.
  assert.deepEqual(found, [
    { path: "app/Z.ts", hits: [0, 1, 2], score: 17.6 },
    { path: "app/a.ts", hits: [0, 1, 2], score: 17.6 },
    { path: "app/m.ts", hits: [0, 1, 2], score: 17.6 },
  ]);
  assert.equal(new Set(found.map(f => f.score)).size, 1);
  assert.equal(new Set(found.map(f => f.path.length)).size, 1);
});

test("findFiles: ranking prefers the file name, then word starts and runs", () => {
  assert.deepEqual(findFiles("src", CORPUS), [
    { path: "src/search.js", hits: [4, 7, 8], score: 51.6 },
    { path: "test/search_test.js", hits: [5, 8, 9], score: 51.3 },
    { path: "src/fmt.ts", hits: [0, 1, 2], score: 17.5 },
    { path: "src/main.js", hits: [0, 1, 2], score: 17.45 },
    { path: "src/listing.js", hits: [0, 1, 2], score: 17.3 },
    { path: "src/util/format-date.js", hits: [0, 1, 2], score: 16.85 },
    { path: "src/components/Router.tsx", hits: [0, 1, 2], score: 16.75 },
    { path: "src/components/router-test.ts", hits: [0, 1, 2], score: 16.55 },
  ]);
});

test("findFiles: hits are positions in the full path, not the name", () => {
  assert.deepEqual(findFiles("srch", CORPUS), [
    { path: "src/search.js", hits: [4, 7, 8, 9], score: 56.6 },
    { path: "test/search_test.js", hits: [5, 8, 9, 10], score: 56.3 },
  ]);
  assert.deepEqual(findFiles("rt", CORPUS).map(f => [f.path, f.hits]), [
    ["lib/router.js", [4, 7]],
    ["test/search_test.js", [8, 12]],
    ["src/components/Router.tsx", [15, 18]],
    ["src/components/router-test.ts", [15, 18]],
    ["src/util/format-date.js", [11, 14]],
    ["src/fmt.ts", [1, 6]],
    ["src/listing.js", [1, 7]],
  ]);
});

// ---- searchContent ----

test("searchContent: an ASCII and a non-ASCII line, from canned rg --json", async () => {
  const rg = [
    JSON.stringify({ type: "begin", data: { path: { text: "./src/ascii.js" } } }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "./src/ascii.js" },
        lines: { text: "const value = 42;\n" },
        line_number: 12,
        absolute_offset: 100,
        submatches: [{ match: { text: "value" }, start: 6, end: 11 }],
      },
    }),
    JSON.stringify({
      type: "match",
      data: {
        path: { text: "./src/unicode.js" },
        // rg reports byte offsets: "café" is 5 bytes but 4 UTF-16 units, and 4 characters.
        lines: { text: "const café = 1;\n" },
        line_number: 3,
        absolute_offset: 200,
        submatches: [{ match: { text: "café" }, start: 6, end: 11 }],
      },
    }),
  ].join("\n");

  onExec("sh", () => ({ code: 0, stdout: rg, stderr: "" }));
  const result = await searchContent("/repo", null, "value", {
    caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "",
  });

  assert.deepEqual(result, {
    files: [
      {
        path: "src/ascii.js",
        matches: [{ line: 12, col: 7, text: "const value = 42;", ranges: [[6, 11]] }],
      },
      {
        path: "src/unicode.js",
        matches: [{ line: 3, col: 7, text: "const café = 1;", ranges: [[6, 10]] }],
      },
    ],
    total: 2,
    truncated: false,
  });
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.exec[0].command, "sh");
});

// ---- listFolder and gitMarks ----

test("listFolder: folders first, dotfiles in, .git out, spaces and newlines kept", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-explorer-list-"));
  try {
    await mkdir(join(dir, "alpha"));
    await mkdir(join(dir, "folder one"));
    await mkdir(join(dir, ".hidden-dir"));
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(dir, "zeta.txt"), "");
    await writeFile(join(dir, "Z.txt"), "");
    await writeFile(join(dir, "a file with space.txt"), "");
    await writeFile(join(dir, "line\nbreak.txt"), "");
    await writeFile(join(dir, ".dotfile"), "");
    await writeFile(join(dir, "beta.md"), "");
    await symlink("alpha", join(dir, "linkdir"));

    onExec("sh", realExec); // the real LIST script, through real sh
    assert.deepEqual(await listFolder(dir, null), [
      { name: ".hidden-dir", dir: true },
      { name: "alpha", dir: true },
      { name: "folder one", dir: true },
      { name: "linkdir", dir: true }, // a symlink to a folder reads as a folder
      { name: ".dotfile", dir: false },
      { name: "a file with space.txt", dir: false },
      { name: "beta.md", dir: false },
      { name: "line\nbreak.txt", dir: false },
      { name: "Z.txt", dir: false },
      { name: "zeta.txt", dir: false },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listFolder: a folder that is gone rejects with the script's error", async () => {
  onExec("sh", realExec);
  await assert.rejects(listFolder("/nonexistent/herdr-explorer-fixture", null), /Cannot list|test -d|No such file/i);
});

test("gitMarks: porcelain letters become marks and their folders become dirty", async () => {
  const porcelain = " M src/a.js\0?? src/new.js\0A  src/added.js\0 D src/gone.js\0UU src/conflict.js\0AM src/util/both.js\0";
  onExec("git", () => ({ code: 0, stdout: porcelain, stderr: "" }));

  const result = await gitMarks("/repo", null);
  assert.deepEqual(result.marks, {
    "/repo/src/a.js": "M",
    "/repo/src/new.js": "A",
    "/repo/src/added.js": "A",
    "/repo/src/gone.js": "D",
    "/repo/src/conflict.js": "U",
    "/repo/src/util/both.js": "A",
  });
  assert.deepEqual([...result.dirty].sort(), ["/repo/src", "/repo/src/util"]);
  assert.equal(calls.exec[0].command, "git");
});

test("gitMarks: a failed git status means no marks and no dirty folders", async () => {
  onExec("git", () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }));
  assert.deepEqual(await gitMarks("/repo", null), { marks: {}, dirty: new Set() });
});

// ---- Explorer.rows() ----

function seededExplorer() {
  // checking() is true in herdr-app check, so init returns before the timers and the watch; it
  // also keeps init out of the TODO loop's way here. Seed after it, as the budget scenarios do.
  state.checking = () => true;
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  explorer.root = "/repo";
  explorer.entries = new Map([
    ["", [
      { name: "src", dir: true },
      { name: "README.md", dir: false },
      { name: ".env", dir: false },
    ]],
    ["src", [
      { name: "main.js", dir: false },
      { name: "lib", dir: true },
      { name: ".hidden", dir: false },
    ]],
    ["src/lib", [{ name: "util.js", dir: false }]],
  ]);
  explorer.open = new Set(["src", "src/lib"]);
  return { explorer, cx };
}

test("Explorer.rows(): open folders walk depth-first, in listing order", () => {
  const { explorer, cx } = seededExplorer();
  assert.deepEqual(explorer.rows(), [
    { path: "src", depth: 0, dir: true, name: "src" },
    { path: "src/main.js", depth: 1, dir: false, name: "main.js" },
    { path: "src/lib", depth: 1, dir: true, name: "lib" },
    { path: "src/lib/util.js", depth: 2, dir: false, name: "util.js" },
    { path: "src/.hidden", depth: 1, dir: false, name: ".hidden" },
    { path: "README.md", depth: 0, dir: false, name: "README.md" },
    { path: ".env", depth: 0, dir: false, name: ".env" },
  ]);
  assert.deepEqual(cx.errors(), []);
});

test("Explorer.rows(): hiding dotfiles drops them at every depth", () => {
  const { explorer } = seededExplorer();
  explorer.showHidden = false;
  assert.deepEqual(explorer.rows().map(r => r.path), [
    "src", "src/main.js", "src/lib", "src/lib/util.js", "README.md",
  ]);
});
