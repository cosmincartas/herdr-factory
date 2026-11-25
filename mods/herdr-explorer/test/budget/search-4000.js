// Budget scenario: a 4,000-row search results list renders inside the host's render budget (C-6a).
//
// `sh test/budget.sh search-4000` installs this file as the mod's main.js, with the real one
// renamed to explorer.js. It seeds 2,000 matches in 2,000 files — a file row and a match row each,
// 4,000 rows — and enters the Search view after super.init() because init returns early while
// checking() is true (herdr-app check). Building one element per result row in render, as the
// results list did before virtualization, is over the host's ~50 ms render budget: check
// interrupts it.
import Explorer from "./explorer.js";

const FILES = 2000;

export default class Search4000 extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    this.root = "/tmp/herdr-explorer-budget/search-4000";
    this.gen = 1;
    this.entries = new Map([["", []]]);
    const files = [];
    for (let i = 0; i < FILES; i++) {
      const path = `packages/app-${i % 50}/src/file-${String(i).padStart(4, "0")}.ts`;
      files.push({
        path,
        matches: [{ line: 1, col: 1, text: `const value = file${i};`, ranges: [[14, 18]] }],
      });
    }
    this.view = "search";
    this.searchInput.set_value("file");
    this.results = { files, total: FILES, truncated: false };
    this.ssel = 0;
  }
}
