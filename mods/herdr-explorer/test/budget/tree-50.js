// Budget scenario: a 50-row tree renders inside the host's render budget (C-0b).
//
// `sh test/budget.sh tree-50` installs this file as the mod's main.js, with the real one renamed
// to explorer.js. It seeds the tree after super.init() because init returns early while
// checking() is true (herdr-app check): the timers and the folder watch never start under check.
import Explorer from "./explorer.js";

export default class Tree50 extends Explorer {
  init(props, cx) {
    super.init(props, cx);
    this.root = "/tmp/herdr-explorer-budget/tree-50";
    this.gen = 1;
    this.entries = new Map([["", Array.from({ length: 50 }, (_, i) => ({
      name: `file-${String(i).padStart(2, "0")}.js`,
      dir: false,
    }))]]);
    this.cursor = "file-00.js";
  }
}
