// C-3b: Find files narrows a longer query from the previous query's matches (P4).
//
// Typing one more character can only remove matches: a path that matches a longer query also
// matches its prefixes. findFiles keeps the file list's matches for the last query and, when the
// new query extends it, looks at those paths only, while answering exactly what a fresh search
// would. Results must stay equal to C-0a's pinned ranking, except that equal-score equal-length
// ties are in code-unit order.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as search from "../search.js";

const { findFiles } = search;
// What the last findFiles call examined arrives with the narrowing, so a RED run reads this
// fallback and fails on the assertion below instead of on a missing export.
const stats = () => search.findStats ?? { examined: NaN, narrowed: false };

// C-0a's corpus, repeated so this check pins the ranking on its own.
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

// A checkout-sized list where one query's matches are a fifth of the list: "ser" matches the
// server folders only, and "serv" extends it.
const BIG = Array.from({ length: 6000 }, (_, i) =>
  `packages/app-${i % 500}/src/${i % 20 === 0 ? "server" : "client"}-${i}/index-${i}.ts`);

// Queries match by code point, as before Task 3: a surrogate half of 😀 must not pair with a
// surrogate half of another character (😁 or 𝘀, here U+10200).
const ASTRAL = ["src/😀.ts", "src/😁-𐘀.ts"];

// "a" matches 200 short a-* names plus nested/folder/az.ts: 201 paths, by construction. No a-* name
// holds a z, and the nested path scores below every a-* path, so it is not among the 200 shown:
// keeping only those shown would lose it as the query grows.
const A_PATHS = [
  ...Array.from({ length: 200 }, (_, i) => `a-${i}.ts`),
  "nested/folder/az.ts",
];

// By construction: 250 same-length filler names match "qq" at 52.4 and tie in code-unit order,
// which is their input order. "a-qq.txt" scores 52.6, higher, but sits at input position 240.
const DEEP = Array.from({ length: 250 }, (_, i) => `f/${String(i).padStart(3, "0")}-qq.txt`);
DEEP.splice(240, 0, "a-qq.txt");
const DEEP_BEST = [
  "a-qq.txt",
  ...Array.from({ length: 199 }, (_, i) => `f/${String(i).padStart(3, "0")}-qq.txt`),
];

test("findFiles: ranking prefers the file name, then word starts and runs", () => {
  assert.deepEqual(findFiles("main", CORPUS), [
    { path: "src/main.js", hits: [4, 5, 6, 7], score: 62.45 },
  ]);
  assert.deepEqual(findFiles("srch", CORPUS), [
    { path: "src/search.js", hits: [4, 7, 8, 9], score: 56.6 },
    { path: "test/search_test.js", hits: [5, 8, 9, 10], score: 56.3 },
  ]);
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

test("findFiles: equal-score equal-length paths sort by code unit", () => {
  assert.deepEqual(findFiles("app", CORPUS), [
    { path: "app/Z.ts", hits: [0, 1, 2], score: 17.6 },
    { path: "app/a.ts", hits: [0, 1, 2], score: 17.6 },
    { path: "app/m.ts", hits: [0, 1, 2], score: 17.6 },
  ]);
});

test("findFiles: an astral query matches whole code points only", () => {
  assert.deepEqual(findFiles("😀", ASTRAL), [
    { path: "src/😀.ts", hits: [4], score: 47.55 },
  ]);
});

test("findFiles: the best 200 are kept, not the first 200 found", () => {
  const all = findFiles("e", BIG, BIG.length);
  const top = findFiles("e", BIG.slice(), 20);
  assert.ok(all.length > 20);
  assert.deepEqual(top, all.slice(0, 20));
});

test("findFiles: the default 200 are the best of more than 200 matches", () => {
  assert.ok(DEEP.indexOf("a-qq.txt") > 200);
  const found = findFiles("qq", DEEP);
  assert.equal(found.length, 200);
  assert.deepEqual(found.map(f => f.path), DEEP_BEST);
});

test("findFiles: a longer query examines only the previous query's matches", () => {
  const list = BIG.slice(); // a fresh file list: no previous query for it
  const first = findFiles("ser", list);
  const firstExamined = stats().examined;

  const narrowed = findFiles("serv", list);
  const narrowedStats = stats();
  assert.ok(narrowedStats.narrowed,
    `narrowed from the previous query: examined ${narrowedStats.examined} of ${list.length} paths`);
  // Independently: every 20th of 6000 entries names a "server" folder, so "ser" matched 300.
  assert.equal(narrowedStats.examined, 300);

  const fresh = findFiles("serv", BIG.slice()); // a new array: a new file list, with no previous query
  assert.equal(first.length, 200);
  assert.equal(firstExamined, list.length);
  assert.equal(narrowed.length, 200);
  assert.deepEqual(narrowed, fresh);

  findFiles("t", list); // does not extend "serv", so it scans the whole list again
  assert.equal(stats().narrowed, false);
  assert.equal(stats().examined, list.length);
});

test("findFiles: an extension matches a path ranked below the previous 200", () => {
  const list = A_PATHS.slice(); // a fresh file list: no previous query for it
  const first = findFiles("a", list);
  assert.equal(first.length, 200);
  assert.ok(!first.some(f => f.path === "nested/folder/az.ts"));
  assert.equal(stats().examined, 201); // independently: 200 a-* paths and one nested path

  const narrowed = findFiles("az", list);
  assert.equal(stats().narrowed, true);
  assert.equal(stats().examined, 201);
  assert.deepEqual(narrowed, [
    { path: "nested/folder/az.ts", hits: [14, 15], score: 52.05 },
  ]);
  assert.deepEqual(narrowed, findFiles("az", A_PATHS.slice())); // a new array: a fresh search
});
