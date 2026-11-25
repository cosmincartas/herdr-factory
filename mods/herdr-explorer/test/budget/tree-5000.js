// Budget scenario: a 5,000-row tree renders inside the host's render budget (C-5a).
//
// `sh test/budget.sh tree-5000` installs this file as the mod's main.js, with the real one
// renamed to explorer.js. It seeds a flat 5,000-entry root after super.init() because init
// returns early while checking() is true (herdr-app check). Rendering 5,000 rows eagerly, as the
// tree did before virtualization, is over the host's ~50 ms render budget: check interrupts it.
import Explorer from "./explorer.js";

const ROWS = 5000;

export default class Tree5000 extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    this.root = "/tmp/herdr-explorer-budget/tree-5000";
    this.gen = 1;
    this.entries = new Map([["", Array.from({ length: ROWS }, (_, i) => ({
      name: `file-${String(i).padStart(4, "0")}.js`,
      dir: false,
    }))]]);
    this.cursor = "file-0000.js";
  }
}
