// Budget scenario: a 5,000-row Find files list renders inside the host's render budget (C-5a).
//
// `sh test/budget.sh found-5000` installs this file as the mod's main.js, with the real one
// renamed to explorer.js. It seeds the matches the Find files tree would show and enters that
// view after super.init() because init returns early while checking() is true (herdr-app check).
// Building one element per match row in render, as the Find files list did before
// virtualization, is over the host's ~50 ms render budget: check interrupts it.
import Explorer from "./explorer.js";

const ROWS = 5000;

export default class Found5000 extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    this.root = "/tmp/herdr-explorer-budget/found-5000";
    this.gen = 1;
    this.entries = new Map([["", []]]);
    this.findQuery = "file";
    this.fqFor = this.findQuery;
    this.found = Array.from({ length: ROWS }, (_, i) => {
      const path = `packages/app-${i % 50}/src/file-${String(i).padStart(4, "0")}.ts`;
      return { path, hits: [path.lastIndexOf("file")], score: 1 };
    });
    this.frows = this.found.map((f, i) => ({
      path: f.path, name: `file-${String(i).padStart(4, "0")}.ts`, depth: 2, dir: false, hits: [[0, 4]],
    }));
    this.fsel = 0;
  }
}
