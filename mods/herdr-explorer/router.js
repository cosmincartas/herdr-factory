// Which Helix pane a file goes to, and how it gets there.
//
// Helix has no remote-control API, and `hc keys` can't type ":" into it (Helix asks
// for detailed key reports, so Shift+; arrives as Shift+;, not ":"). So the router
// leaves the path in a per-terminal file and presses one key that Helix binds to
//   F12 = ":open %sh{herdr-explorer take}"
// `herdr-explorer take` prints that file and deletes it (see bin/herdr-explorer).
import { panes, focused, exec, hc, run, readTextFile, writeTextFile } from "herdr";

/** Program keys Herdr gives Helix panes (evil-helix's binary is also `hx`). */
export const EDITORS = new Set(["hx"]);
/** The key Helix binds to `:open %sh{herdr-explorer take}`. */
export const OPEN_KEY = "f12";
/** `hc keys` takes about 32 ms per key, so OPEN_KEY goes alone first. If Helix hasn't taken
 *  the file within this many ms (a picker or prompt is open, or insert mode without the
 *  binding), Esc then OPEN_KEY follow. Remote Helix panes always get both at once. */
export const FALLBACK_AFTER = 150;
/** What a new editor pane runs when no Helix pane is open. */
export const EDITOR_ARGV = ["hx"];

// $1: the terminal's id, $2: the path. Written whole, then renamed, so `take` never reads half.
const QUEUE = 'd="${XDG_RUNTIME_DIR:-/tmp}/herdr-explorer"; mkdir -p "$d" && printf "%s" "$2" > "$d/$1.tmp" && mv -f "$d/$1.tmp" "$d/$1" && printf "%s" "$d/$1"';

/** localStorage key: the paired and last focused Helix per tab, shared with link.js (Ctrl+clicks). */
const STORE = "router";

const machineOf = address => (address?.includes("/") ? address.split("/")[0] : null);
const idOf = address => address.split("/").pop();
export const isEditor = p => Boolean(p?.terminal) && EDITORS.has(p.program?.key);

export class Router {
  // Everything is kept per tab: a file only ever goes to a Helix in the tab you're in.
  // `paired` (tab -> the editor files go to: the last one opened into, or the one that asked
  // to reveal) and `lastEditor` (tab -> the last focused Helix) live in localStorage, so the
  // explorer and link.js (a separate copy of this class) pick the same Helix.
  constructor() {
    /** tab -> the last focused terminal pane (to split beside). */
    this.lastPane = new Map();
    this.seen = new Map();  // tab -> the lastEditor last stored, so render doesn't rewrite it
  }

  stored() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? "{}");
      return { paired: s.paired ?? {}, lastEditor: s.lastEditor ?? {} };
    } catch { return { paired: {}, lastEditor: {} }; }
  }

  remember(kind, tab, terminal) {
    const s = this.stored();
    if (s[kind][tab] === terminal) return;
    s[kind][tab] = terminal;
    const live = new Set(panes().map(p => p.tab));  // closed tabs drop out
    for (const k of ["paired", "lastEditor"]) for (const t of Object.keys(s[k])) if (!live.has(t)) delete s[k][t];
    localStorage.setItem(STORE, JSON.stringify(s));
  }

  /** Call on render: remembers what had the keyboard before the explorer. */
  observe() {
    const f = focused();
    if (!f?.terminal || !f.pane) return;
    const p = panes().find(p => p.pane === f.pane);
    if (!p?.terminal) return;
    this.lastPane.set(p.tab, p.pane);
    if (isEditor(p) && this.seen.get(p.tab) !== p.terminal) {
      this.seen.set(p.tab, p.terminal);
      this.remember("lastEditor", p.tab, p.terminal);
    }
  }

  /** Pairs a Helix (one that asked to reveal) for its own tab. */
  pair(terminal) {
    const tab = panes().find(p => p.terminal === terminal)?.tab ?? focused()?.tab;
    if (tab) this.remember("paired", tab, terminal);
  }

  /** The Helix pane in `tab` (default: the current one) to open in: the paired one, else the
   *  last focused one, else any. Null: that tab has none (a Helix in another tab doesn't count). */
  target(tab = focused()?.tab) {
    if (!tab) return null;
    const editors = panes().filter(p => p.tab === tab && isEditor(p)), s = this.stored();
    const live = t => (t ? editors.find(p => p.terminal === t) : null);
    return live(s.paired[tab]) ?? live(s.lastEditor[tab]) ?? editors[0] ?? null;
  }

  /** Opens `path` in the target editor, or in a new Helix pane. Resolves with
   *  { terminal, queued, on } for a handed-over file, or null for a new pane. */
  /** `sleep(ms)`: the caller's cx.sleep (scripts have no setTimeout); without one, Esc and
   *  OPEN_KEY go together. `tab`: open in that tab's Helix; `beside`: the pane a new one splits from. */
  async open(path, { folder, focus = true, sleep, tab, beside } = {}) {
    const p = this.target(tab);
    if (!p) { this.spawn(path, folder, beside); return null; }
    const on = machineOf(p.terminal);
    // Focus first: the pane answers at once, the file follows a few key presses later.
    if (focus) run("pane.focus", { terminal: p.terminal });
    const queued = await this.queue(idOf(p.terminal), path, on);
    if (on || !sleep) await this.press(p.terminal, ["esc", OPEN_KEY]);
    else {
      await this.press(p.terminal, [OPEN_KEY]);
      if (!(await this.taken(queued, FALLBACK_AFTER, sleep))) await this.press(p.terminal, ["esc", OPEN_KEY]);
    }
    this.remember("paired", p.tab, p.terminal);
    return { terminal: p.terminal, queued, on };
  }

  /** Leaves `path` where `herdr-explorer take` finds it; resolves with that file. Here it's
   *  written in-process (`runtime`: the explorer's runtime folder, once known), else by a shell. */
  async queue(id, path, on) {
    if (!on && this.runtime) {
      const file = `${this.runtime}/${id}`;
      // A file Helix never took gets replaced; `take` may delete it under us, so try again.
      for (let i = 0; i < 3; i++) {
        try { await writeTextFile(file, path, await readTextFile(file)); return file; } catch {}
      }
    }
    const q = await exec("sh", ["-c", QUEUE, "herdr-explorer", id, path], { on });
    if (q.code !== 0) throw new Error(q.stderr.trim() || "Cannot queue the file for Helix");
    return q.stdout;
  }

  async press(terminal, keys) {
    const k = await hc(["keys", terminal, ...keys]);
    if (k.code !== 0) throw new Error(k.stderr.trim() || `hc keys ${terminal} failed`);
  }

  /** True once Helix has taken the queued file (`take` deletes it), false after `ms`. */
  async taken(file, ms, sleep) {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if ((await readTextFile(file).catch(() => "")) === null) return true;
      await sleep(10);
    }
    return false;
  }

  /** Focuses the editor files go to; false when there is none. */
  focusEditor() {
    const p = this.target();
    if (p) run("pane.focus", { terminal: p.terminal });
    return Boolean(p);
  }

  spawn(path, folder, beside) {
    const args = { argv: [...EDITOR_ARGV, path], folder };
    // A split goes beside the focused pane; start from this tab's last terminal pane, not the explorer.
    const tab = focused()?.tab, last = beside ?? (tab ? this.lastPane.get(tab) : null);
    if (last && panes().some(p => p.pane === last)) run("pane.focus", { pane: last });
    try { run("terminal.open", { ...args, place: "right" }); }
    catch { run("terminal.open", { ...args, place: "tab" }); }
  }
}
