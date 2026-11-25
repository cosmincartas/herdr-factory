// Explorer: a keyboard-driven file tree that opens files in a Helix pane beside it,
// with Find files (fuzzy, by name) and Search (file contents, ripgrep), like Orca's.
//
// The tree is rooted at the git checkout (else folder) of the terminal last focused.
// Files open in the paired Helix pane (see router.js); Helix can ask the explorer to
// reveal its current file with `herdr-explorer reveal` (see bin/herdr-explorer).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input, Popover } from "gpui-base";
import { spaces, panes, focused, theme, nextCommand, notify, checking, exec, readTextFile, watchFolder } from "herdr";
import { listFolder, gitTop, gitMarks, TOTAL } from "./listing.js";
import { listFiles, findFiles, searchContent, columnOf, MAX_FILE_RESULTS, MAX_MATCHES } from "./search.js";
import { Router } from "./router.js";

const ICON = name => `mods/herdr-explorer/${name}.svg`;
const parentOf = path => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = path => path.slice(path.lastIndexOf("/") + 1);
const placeKey = (root, on) => JSON.stringify([root, on]);
const message = e => String(e?.message ?? e);
const clamp = (n, max) => Math.max(0, Math.min(max, n));
/** A theme color at some opacity (theme colors are #rrggbb). */
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
const CLEAR = "#00000000";
/** How long Helix gets to take a queued file before the explorer says the binding is missing. */
const TAKE_TIMEOUT = 5000;
/** A Find files / Search request older than this (bin/herdr-explorer) is a leftover, not a wish. */
const PENDING_MAX_AGE = 5000;
/** localStorage key: the request this mod already applied, so a fresh copy does not apply it again. */
const HANDLED_COMMAND = "herdr-explorer.command.handled";
/** Content search waits this long after the last keystroke. */
const SEARCH_DEBOUNCE = 200;
/** Tree and Find files rows are this tall, inside this much padding: how `gw` knows which rows are on screen. */
const ROW_H = 24, LIST_PAD = 8;
/** A search result's two fixed heights (Task 4's spike): a file row is 6 px above a 22 px row, a
 *  match row is an 18 px row with 1 px of padding each side. */
const RESULT_FILE_H = 28, RESULT_MATCH_H = 20;
/** `gw` labels, like Helix's jump-label-alphabet: one letter while the rows fit, else two. */
const JUMP_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const jumpLabels = n => n <= JUMP_ALPHABET.length ? [...JUMP_ALPHABET].slice(0, n)
  : [...JUMP_ALPHABET].flatMap(a => [...JUMP_ALPHABET].map(b => a + b)).slice(0, n);
/** How many folders one refresh lists at once (remote spaces list slower). */
const LIST_PARALLEL = 8;

/** The absolute path of folder `rel` under `root` ("" is the root itself), without a doubled slash. */
const folderAt = (root, rel) => (!rel ? root : root === "/" ? `/${rel}` : `${root}/${rel}`);
/** The folder holding `path`; unlike parentOf, "/top.js" sits in "/" and not in "". */
const dirOf = path => { const at = path.lastIndexOf("/"); return at > 0 ? path.slice(0, at) : at === 0 ? "/" : ""; };

/** Lists these folders (relative to `root`, "" for the root) at most LIST_PARALLEL at a time.
 *  Resolves with { entries: Map rel -> entries, failed: [rel], error }; the root's failure rejects
 *  and `error` stays null, and only once every listing already started has settled, so no two
 *  passes list at the same time. `partial` resolves anyway, with the root's failure in `error`, and
 *  keeps listing the folders still queued, so the folders that did list are not lost.
 *  `stop()` ends the pool after the listings in flight: a root switch has nothing left to list.
 *  `gone(rel, error)` hears each child folder whose listing failed, as soon as it fails. */
async function listFolders(root, on, rels, stop = () => false, gone = () => {}, partial = false) {
  const entries = new Map(), failed = [];
  let at = 0, halted = false, error = null;
  const worker = async () => {
    while (!halted && at < rels.length && !stop()) {
      const rel = rels[at++];
      try { entries.set(rel, await listFolder(rel ? folderAt(root, rel) : root, on)); }
      catch (e) { if (rel) { failed.push(rel); gone(rel, e); } else { halted = !partial; error = e; } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_PARALLEL, rels.length) }, worker));
  if (error && !partial) throw error;
  return { entries, failed, error };
}

export default class Explorer extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();   // the tree
    this.fscroll = VirtualListScrollHandle.new();  // Find files
    this.rscroll = VirtualListScrollHandle.new();  // search results
    this._rows = null;                 // rows() built once per state change (P6)
    this._resultRows = null; this._resultSizes = null;  // resultRows() likewise
    this.resultsRev = 0;               // bumped when the result set is replaced (T6-01)
    this.router = new Router();
    this.root = null; this.on = null; this.gen = 0;
    this.seen = null;          // the focused terminal folder the root was last picked from
    this.entries = new Map();  // folder (relative, "" for the root) -> its entries
    this.open = new Set();     // expanded folders, relative
    this.marks = {}; this.dirty = new Set();
    this.cursor = null; this.showHidden = true;
    this.pending = null;       // "g" after a g, waiting for gg / ge / gw (Helix's goto mode)
    this.jump = null;          // gw labels on screen: { list, at: label -> row index, byIndex, typed }
    this.error = null; this.loading = false; this.again = false; this.againChanged = undefined;
    this.memory = new Map();   // root -> { open, cursor }: each project keeps its folds
    this.tops = new Map();     // root -> its git checkout: one rev-parse per root, not per refresh
    this.runtime = null; this.lastReveal = null; this.readingCommand = false; this.commandAgain = false;
    // localStorage outlives a reload or another copy of this mod: a request already applied must not
    // reopen the panel when init runs again.
    this.lastCommand = localStorage.getItem(HANDLED_COMMAND) ?? null;

    this.view = "tree";        // "tree" (with Find files over it) or "search"
    this.typing = null;        // the input with the keyboard: "find" | "search" | "include" | "exclude"
    this.files = { key: null, paths: [], stale: true, loading: false };
    this.findQuery = ""; this.found = []; this.fsel = 0;
    this.frows = []; this.fclosed = new Set(); this.fqFor = null;  // Find files matches, shown as a tree
    this.menuOpen = false;
    this.opts = { caseSensitive: false, wholeWord: false, regex: false, details: false };
    this.results = null; this.searching = false; this.searchError = null; this.ssel = 0; this.collapsed = new Set(); this.seq = 0;
    this.searchTimer = null; this.searchAgain = false;  // one rg at a time: the latest query waits here

    this.findInput = this.input("find", "Find files", cx => {
      this.findQuery = this.findInput.value();
      this.ensureFiles(cx); this.filterFiles();
    }, (e, cx) => this.activate("find", !e.shift, cx));
    const research = cx => this.scheduleSearch(cx), open = (e, cx) => this.activate("search", !e.shift, cx);
    this.searchInput = this.input("search", "Search", research, open);
    this.includeInput = this.input("include", "files to include, e.g. *.ts, src/**", research, open);
    this.excludeInput = this.input("exclude", "files to exclude, e.g. *.min.js, dist/**", research, open);

    cx.spawn(async cx => { for (;;) { const c = await nextCommand(); this.command(c, cx); cx.notify(); } });
    if (checking()) return;
    cx.spawn(async cx => this.watchReveals(cx));
    // Render only notes which folder the tree should show (follow); this picks it up. Work
    // started from render stalls until the next event, so it starts from a timer instead.
    cx.timer.every(250, cx => this.settleRoot(cx));
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  input(name, placeholder, onChange, onSubmit) {
    const input = InputState.new({ placeholder });
    input.on("focus", (_e, cx) => { this.typing = name; cx.notify(); });
    input.on("blur", (_e, cx) => { if (this.typing === name) this.typing = null; cx.notify(); });
    input.on("change", (_e, cx) => { onChange(cx); cx.notify(); });
    input.on("submit", (e, cx) => { onSubmit(e, cx); cx.notify(); });
    return input;
  }

  // keys.json: "alt-e": "herdr-explorer.toggle-focus" (also "focus", "find-files", "search", "reveal").
  // "find-files:<text>" and "search:<text>" start with that text (bin/herdr-explorer find|search TEXT,
  // which leaves the request for "pending" to apply).
  command(c, cx) {
    const at = c.indexOf(":"), name = at < 0 ? c : c.slice(0, at), text = at < 0 ? null : c.slice(at + 1);
    // An internal wake only looks for a request: clearing the g / gw prefix here would cancel the
    // key the user pressed just before it. Only Find files and Search (which a request re-enters
    // through) clear it.
    if (name === "pending") { cx.spawn(async cx => this.pendingCommand(cx)); return; }
    if (name === "focus") this.handle.focus();
    else if (name === "toggle-focus") { if (!(this.handle.is_focused() || this.typing) || !this.router.focusEditor()) this.handle.focus(); }
    else if (name === "find-files") {
      this.pending = this.jump = null;
      this.startFind(cx);
      if (text !== null) { this.findInput.set_value(text); this.findQuery = text; this.filterFiles(); }
    } else if (name === "search") {
      this.pending = this.jump = null;
      if (text !== null) { this.searchInput.set_value(text); this.replaceResults(null); }
      this.startSearch(cx);
      if (text !== null) this.scheduleSearch(cx);
    } else if (name === "reveal") cx.spawn(async cx => this.reveal(cx));
  }

  // ---- where the tree is rooted ----

  /** On render: notes the folder the tree should follow (the focused terminal's, else the
   *  space's until there is a root). settleRoot does the rest. */
  follow() {
    this.router.observe();
    const f = focused(), space = spaces().find(s => s.active), on = space?.machine ?? null;
    const pane = f?.terminal && f.pane ? panes().find(p => p.pane === f.pane) : null;
    if (pane?.cwd) this.want = { cwd: pane.cwd, on, key: placeKey(pane.cwd, on) };
    else if (!this.root && !this.want && space?.folder) this.want = { cwd: space.folder, on, key: placeKey(space.folder, on) };
  }

  /** Roots the tree at the git checkout (else folder) of the folder follow() noted. */
  settleRoot(cx) {
    const want = this.want;
    if (!want || want.key === this.seen) return;
    this.seen = want.key;
    cx.spawn(async cx => {
      const top = (await gitTop(want.cwd, want.on)) ?? want.cwd;
      if (this.seen === want.key) { this.setRoot(top, want.on, cx); cx.notify(); }
    });
  }

  setRoot(root, on, cx) {
    if (root === this.root && on === this.on) return;
    if (this.root) this.memory.set(placeKey(this.root, this.on), { open: this.open, cursor: this.cursor });
    const saved = this.memory.get(placeKey(root, on));
    this.root = root; this.on = on; this.gen++;
    this.entries = new Map(); this.open = new Set(saved?.open); this.cursor = saved?.cursor ?? null;
    this.invalidateRows();
    this.marks = {}; this.dirty = new Set(); this.error = null; this.loading = false; this.again = false;
    this.againChanged = undefined;
    this.found = []; this.frows = []; this.fsel = 0; this.replaceResults(null); this.ssel = 0;
    this.watchRoot(cx);
    this.refresh(cx);
    if (this.findQuery) this.ensureFiles(cx);
    if (this.view === "search") this.scheduleSearch(cx);
  }

  watchRoot(cx) {
    this.rootWatch?.cancel();
    this.rootWatch = null;
    if (this.on || checking()) return;  // folder watches are local only; the timer covers remote spaces
    const gen = this.gen, root = this.root;
    cx.spawn(async cx => {
      while (this.gen === gen) {
        this.rootWatch = watchFolder(root);
        let changed;
        try { changed = await this.rootWatch; } catch { return; }  // too big to watch: the 10 s timer refreshes
        if (this.gen !== gen) return;
        this.files.stale = true;
        if (this.findQuery) this.ensureFiles(cx);
        this.refresh(cx, changed);
      }
    });
  }

  // ---- loading the tree ----

  /** The folders a refresh lists: all of them for a full refresh; for a watch batch, the open
   *  folders (and the root) that hold a changed path, and all of them when it holds the root. */
  affected(changed) {
    const all = ["", ...this.open];
    if (!changed) return all;
    if (changed.includes(this.root)) return all;
    const parents = new Set(changed.map(dirOf));
    return all.filter(rel => parents.has(folderAt(this.root, rel)));
  }

  /** The git checkout holding `root`, remembered per place: rev-parse runs once per root.
   *  The pending lookup is published before it is awaited, so a second refresh of the same place
   *  shares it; an unsuccessful probe is forgotten and tried again on the next refresh. */
  checkout(root, on) {
    const key = placeKey(root, on);
    let top = this.tops.get(key);
    if (top === undefined) { top = gitTop(root, on); this.tops.set(key, top); }
    return Promise.resolve(top).then(result => {
      if (result === null && this.tops.get(key) === top) this.tops.delete(key);
      return result;
    });
  }

  refresh(cx, changed) {
    if (!this.root) return;
    if (this.on) this.files.stale = true;  // no watch on remote spaces
    if (this.loading) {
      // A full refresh wins over a targeted one (null); otherwise the next pass takes every batch
      // it missed, starting with the first one queued.
      this.again = true;
      if (changed == null) this.againChanged = null;
      else if (this.againChanged !== null) this.againChanged = [...(this.againChanged ?? []), ...changed];
      return;
    }
    this.loading = true; this.again = false; this.againChanged = undefined;
    const gen = this.gen, root = this.root, on = this.on, rels = this.affected(changed);
    cx.spawn(async cx => {
      try {
        // A folder that went away closes at once, with the rows cached while it was open, so a render or
        // key during the remaining listings cannot select one of its children.
        const listed = await listFolders(root, on, rels, () => this.gen !== gen,
          rel => { if (this.gen === gen && this.open.delete(rel)) this.invalidateRows(); });
        if (this.gen !== gen) return;
        for (const rel of listed.failed) this.open.delete(rel);  // a folder that went away
        // Update in place: a folder opened while this ran (a reveal, a click) keeps its listing.
        for (const [rel, list] of listed.entries) if (rel === "" || this.open.has(rel)) this.entries.set(rel, list);
        for (const rel of [...this.entries.keys()]) if (rel && !this.open.has(rel)) this.entries.delete(rel);
        this.invalidateRows();
        this.error = null;
        // The tree shows now; git status may take its time on a large checkout and lands after.
        cx.notify();
        const top = await this.checkout(root, on);
        const git = top ? await gitMarks(top, on) : { marks: {}, dirty: new Set() };
        if (this.gen !== gen) return;
        this.marks = git.marks; this.dirty = git.dirty;
      } catch (e) { if (this.gen === gen) this.error = message(e); }
      finally {
        if (this.gen === gen) {
          this.loading = false;
          if (this.again) this.refresh(cx, this.againChanged);
        }
        cx.notify();
      }
    });
  }

  async load(rel) {
    const gen = this.gen;
    try {
      const list = await listFolder(rel ? `${this.root}/${rel}` : this.root, this.on);
      if (this.gen === gen && (rel === "" || this.open.has(rel))) { this.entries.set(rel, list); this.invalidateRows(); }
    } catch (e) { if (this.gen === gen) this.error = message(e); }
  }

  toggle(rel, cx) {
    if (this.open.has(rel)) {
      for (const f of [...this.open]) if (f === rel || f.startsWith(rel + "/")) { this.open.delete(f); this.entries.delete(f); }
    } else {
      this.open.add(rel);
      if (!this.entries.has(rel)) cx.spawn(async cx => { await this.load(rel); cx.notify(); });
    }
    this.invalidateRows();
  }

  /** Folds every folder (the toolbar's Collapse All); the cursor moves to its top folder. */
  collapseAll() {
    this.open = new Set();
    for (const rel of [...this.entries.keys()]) if (rel) this.entries.delete(rel);
    this.invalidateRows();
    if (this.cursor) this.cursor = this.cursor.split("/")[0];
  }

  /** Forgets the built row list (P6): every change that adds, removes or folds a row calls this. */
  invalidateRows() {
    this._rows = null;
  }

  rows() {
    if (this._rows) return this._rows;
    const out = [];
    const walk = (rel, depth) => {
      for (const e of this.entries.get(rel) ?? []) {
        if (out.length >= TOTAL) return;
        if (!this.showHidden && e.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        out.push({ path, depth, dir: e.dir, name: e.name });
        if (e.dir && this.open.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return (this._rows = out);
  }

  // ---- Find files ----

  /** Loads the checkout's file list if it is missing or something changed since. */
  ensureFiles(cx) {
    if (!this.root) return;
    const key = placeKey(this.root, this.on);
    if (this.files.key !== key) this.files = { key, paths: [], stale: true, loading: false };
    if (!this.files.stale || this.files.loading) return;
    const files = this.files, root = this.root, on = this.on;
    files.loading = true;
    cx.spawn(async cx => {
      try { const paths = await listFiles(root, on); if (this.files === files) { files.paths = paths; files.stale = false; } }
      catch (e) { if (this.files === files) files.error = message(e); }
      finally { files.loading = false; if (this.files === files) this.filterFiles(); cx.notify(); }
    });
  }

  /** Matches the query again. A new query unfolds everything and selects the best match;
   *  a new file list (a refresh) keeps the folds and the selected row. */
  filterFiles() {
    this.found = findFiles(this.findQuery, this.files.paths);
    const fresh = this.fqFor !== this.findQuery, was = this.frows[this.fsel]?.path;
    if (fresh) { this.fqFor = this.findQuery; this.fclosed = new Set(); }
    this.buildFiltered();
    const keep = fresh ? -1 : this.frows.findIndex(r => r.path === was);
    this.fsel = keep >= 0 ? keep : Math.max(0, this.frows.findIndex(r => r.path === this.found[0]?.path));
  }

  /** Find files matches as a tree, like Orca's name filter: their folders, folders first. */
  buildFiltered() {
    const top = { dirs: new Map(), files: [] };
    for (const f of this.found) {
      const parts = f.path.split("/");
      let node = top;
      for (const name of parts.slice(0, -1)) {
        if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] });
        node = node.dirs.get(name);
      }
      node.files.push(f);
    }
    const out = [];
    const walk = (node, rel, depth) => {
      for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        const path = rel ? `${rel}/${name}` : name;
        out.push({ path, name, depth, dir: true });
        if (!this.fclosed.has(path)) walk(child, path, depth + 1);
      }
      for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
        const base = f.path.lastIndexOf("/") + 1;
        // Matched letters in the name, runs of neighbours joined: [[start, end]].
        const hits = [];
        for (const h of f.hits) if (h >= base) {
          const last = hits[hits.length - 1];
          if (last && last[1] === h - base) last[1]++; else hits.push([h - base, h - base + 1]);
        }
        out.push({ path: f.path, name: f.path.slice(base), depth, dir: false, hits });
      }
    };
    walk(top, "", 0);
    this.frows = out;
  }

  /** Folds or unfolds a folder among the Find files matches, keeping it selected. */
  toggleFiltered(path) {
    if (this.fclosed.has(path)) this.fclosed.delete(path); else this.fclosed.add(path);
    this.buildFiltered();
    this.fsel = clamp(this.frows.findIndex(r => r.path === path), this.frows.length - 1);
  }

  // ---- Search ----

  scheduleSearch(cx) {
    this.seq++;
    this.searchTimer?.cancel();
    this.searchTimer = null;
    // exec has no cancel handle: while rg runs, keep only the latest query and start it when it settles.
    if (this.searching) { this.searchAgain = true; return; }
    this.searchTimer = cx.timer.after(SEARCH_DEBOUNCE, cx => { this.searchTimer = null; this.runSearch(cx); });
  }

  runSearch(cx) {
    const seq = this.seq;
    const query = this.searchInput.value(), root = this.root, on = this.on;
    if (!query || !root) { this.replaceResults(null); this.searching = false; this.searchError = null; this.searchAgain = false; cx.notify(); return; }
    this.searching = true; this.searchError = null; this.searchAgain = false;
    cx.notify();
    const opts = { ...this.opts, include: this.includeInput.value(), exclude: this.excludeInput.value() };
    cx.spawn(async cx => {
      try {
        const results = await searchContent(root, on, query, opts);
        if (seq === this.seq) { this.replaceResults(results); this.ssel = 0; this.collapsed = new Set(); this.rscroll.scroll_to_item(0); }
      } catch (e) { if (seq === this.seq) { this.replaceResults(null); this.searchError = message(e); } }
      finally {
        if (this.searchAgain) { this.searchAgain = false; this.runSearch(cx); return; }
        this.searching = false;
        cx.notify();
      }
    });
  }

  /** Forgets the built result rows (P6): every change of the results or their folds calls this. */
  invalidateResultRows() {
    this._resultRows = null;
    this._resultSizes = null;
  }

  /** Replaces the result set: new results, an error, a clear, or another root. The rows' keys carry
   *  a new revision, so a click already pressed against the old rows resolves to nothing instead of
   *  a different match that took the same position (T6-01). Folds keep the revision, since they do
   *  not change which result a row shows. */
  replaceResults(results) {
    this.results = results;
    this.resultsRev++;
    this.invalidateResultRows();
  }

  /** The result rows, built once per change of the results or their folds (P6). Each row carries
   *  the key its virtual list's `on_item_click` reports: a file row, then its match rows. */
  resultRows() {
    if (this._resultRows) return this._resultRows;
    const out = [];
    for (const f of this.results?.files ?? []) {
      const matches = f.matches, open = !this.collapsed.has(f.path);
      out.push({ kind: "file", key: `f:${this.resultsRev}:${f.path}`, path: f.path, count: matches.length });
      for (let n = 0; open && n < matches.length; n++) {
        out.push({ kind: "match", path: f.path, ...matches[n], key: `m:${this.resultsRev}:${f.path}:${n}` });
      }
    }
    return (this._resultRows = out);
  }

  /** The result rows' heights for their virtual list, one per row and built with them: a match row
   *  is shorter than a file row, so the list cannot take a single height. */
  resultSizes() {
    if (this._resultSizes) return this._resultSizes;
    const rows = this.resultRows(), sizes = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) sizes[i] = rows[i].kind === "file" ? RESULT_FILE_H : RESULT_MATCH_H;
    return (this._resultSizes = sizes);
  }

  toggleOpt(name, cx) {
    this.opts[name] = !this.opts[name];
    if (name !== "details") this.scheduleSearch(cx);
  }

  // ---- moving between the tree, Find files and Search ----

  /** Focuses an input that a key ("/" or "?") opened, dropping the key if it got typed. */
  focusInput(input, typed, cx) {
    const before = input.value();
    input.focus();
    if (typed) cx.timer.after(30, () => { if (input.value() === before + typed) input.set_value(before); });
  }

  startFind(cx, typed) {
    this.view = "tree";
    this.ensureFiles(cx);
    this.focusInput(this.findInput, typed, cx);
  }

  startSearch(cx, typed) {
    this.view = "search";
    this.focusInput(this.searchInput, typed, cx);
    if (this.searchInput.value() && !this.results) this.scheduleSearch(cx);
  }

  /** Back from an input or a results list: Find files clears; Search goes back to the tree. */
  back() {
    if (this.view === "search") this.view = "tree";
    else if (this.findQuery) this.clearFind();
    this.handle.focus();
  }

  clearFind() {
    this.findInput.set_value(""); this.findQuery = ""; this.found = []; this.frows = []; this.fqFor = null;
  }

  move(list, by) {
    if (list === "find") {
      this.fsel = clamp(this.fsel + by, this.frows.length - 1);
      this.fscroll.scroll_to_item(this.fsel);
    } else {
      const rows = this.resultRows();
      this.ssel = clamp(this.ssel + by, rows.length - 1);
      this.rscroll.scroll_to_item(this.ssel);
    }
  }

  /** Enter on a Find files or Search row. */
  activate(list, focus, cx) {
    if (list === "find") {
      const r = this.frows[this.fsel];
      if (r?.dir) this.toggleFiltered(r.path);
      else if (r) this.openFile(r.path, focus, cx);
      return;
    }
    const row = this.resultRows()[this.ssel];
    if (!row) return;
    if (row.kind === "file") this.collapse(row.path);
    else this.openFile(row.path, focus, cx, row);
  }

  collapse(path) {
    if (this.collapsed.has(path)) this.collapsed.delete(path); else this.collapsed.add(path);
    this.invalidateResultRows();
    const rows = this.resultRows();
    this.ssel = clamp(rows.findIndex(r => r.kind === "file" && r.path === path), rows.length - 1);
  }

  // ---- talking to Helix ----

  /** Opens `rel` in Helix, at `at.line`/`at.col` when given (Helix's :open takes path:line:col).
   *  A search row from far into a long non-ASCII line carries its column unresolved; opening it
   *  is where that exact column is computed. */
  openFile(rel, focus, cx, at) {
    const path = `${this.root}/${rel}${at ? `:${at.line}:${columnOf(at)}` : ""}`;
    cx.spawn(async cx => {
      try {
        const sent = await this.router.open(path, { folder: this.root, focus, sleep: ms => cx.sleep(ms) });
        if (!sent) return;
        await cx.sleep(TAKE_TIMEOUT);
        const left = await exec("sh", ["-c", 'test -e "$1"', "sh", sent.queued], { on: sent.on }).catch(() => null);
        if (left?.code === 0) notify({ level: "warning", title: "Helix didn't open the file",
          body: `Bind F12 in Helix: [keys.normal] F12 = ":open %sh{herdr-explorer take}" (see the herdr-explorer README).` });
      } catch (e) { notify({ level: "error", title: "Explorer", body: message(e) }); }
      cx.notify();
    });
  }

  async watchReveals(cx) {
    const r = await exec("sh", ["-c", 'd="${XDG_RUNTIME_DIR:-/tmp}/herdr-explorer"; mkdir -p "$d" && printf "%s" "$d"']).catch(() => null);
    if (r?.code !== 0) return;
    this.runtime = r.stdout;
    this.router.runtime = this.runtime;  // lets the router queue files without a shell
    await this.pendingCommand(cx);  // a find/search asked for before the panel started
    for (;;) {
      let changed;
      try { changed = await watchFolder(this.runtime); } catch { await cx.sleep(5000); continue; }
      if (changed.some(p => p === this.runtime || p.endsWith("/command"))) await this.pendingCommand(cx);
      if (changed.some(p => p === this.runtime || p.endsWith("/reveal"))) await this.reveal(cx);
    }
  }

  /** The text of a request file bin/herdr-explorer wrote (a temp file renamed into place) once:
   *  null when it is missing, or is the one `last` already handled. */
  async readRequest(name, last) {
    if (!this.runtime) return null;
    const text = await readTextFile(`${this.runtime}/${name}`).catch(() => null);
    return text && text !== last ? text : null;
  }

  /** Applies the Find files / Search request bin/herdr-explorer left behind, if it is new and
   *  recent: the CLI does not wait for the panel to start, and skips the mod when it already ran.
   *  A wake or watch batch that arrives while a read is in flight asks for one more read, so a
   *  request renamed into place mid-read is not missed. */
  async pendingCommand(cx) {
    if (this.readingCommand) { this.commandAgain = true; return; }
    this.readingCommand = true;
    try {
      const text = await this.readRequest("command", this.lastCommand);
      if (!text) return;
      this.lastCommand = text;
      // Framing (bin/herdr-explorer): command, 1/0 for a text argument, timestamp, then the text,
      // which may hold tabs of its own. A timestamp is not read as text or the other way round.
      const line = text.replace(/\n$/, "");
      const a = line.indexOf("\t"), b = line.indexOf("\t", a + 1), c = line.indexOf("\t", b + 1);
      if (a < 0 || b < 0 || c < 0) return;
      const name = line.slice(0, a), present = line.slice(a + 1, b), stamp = line.slice(b + 1, c);
      const arg = line.slice(c + 1);
      if (!(Date.now() - Number(stamp) <= PENDING_MAX_AGE)) return;
      localStorage.setItem(HANDLED_COMMAND, text);
      this.command(present === "1" ? `${name}:${arg}` : name, cx);
      cx.notify();
    } finally {
      this.readingCommand = false;
      if (this.commandAgain) { this.commandAgain = false; cx.spawn(async cx => this.pendingCommand(cx)); }
    }
  }

  /** Shows the file a Helix asked for (bin/herdr-explorer reveal) and pairs with that Helix. */
  async reveal(cx) {
    const text = await this.readRequest("reveal", this.lastReveal);
    if (!text) return;
    this.lastReveal = text;
    const [id, path] = text.replace(/\n$/, "").split("\t");
    if (!path?.startsWith("/")) return;
    if (id) this.router.pair(id);
    if (!this.root || this.on || !path.startsWith(this.root + "/")) {
      const dir = parentOf(path) || "/";
      this.setRoot((await gitTop(dir, null)) ?? dir, null, cx);
    }
    if (this.view === "search" || this.findQuery) { this.view = "tree"; this.clearFind(); }
    const rel = path.slice(this.root.length + 1), parts = rel.split("/");
    // The root and every folder above the file, listed together by the refresh helper instead of
    // one at a time: on a remote space each listing is a round trip of its own (P9).
    const gen = this.gen, root = this.root, on = this.on, ancestors = [""];
    for (let k = 1; k < parts.length; k++) ancestors.push(parts.slice(0, k).join("/"));
    for (const dir of ancestors) if (dir) this.open.add(dir);
    const missing = ancestors.filter(dir => !this.entries.has(dir));
    if (missing.length) {
      // A folder that cannot be listed says why in the tree note, as load() did. A failed root
      // listing keeps the ancestors that did list: a refresh may already have the root, and the
      // file can still be shown and scrolled to.
      const listed = await listFolders(root, on, missing, () => this.gen !== gen,
        (dir, e) => { if (this.gen === gen) this.error = message(e); }, true);
      if (this.gen !== gen) return;  // the root moved on, and its refresh owns the tree now
      if (listed.error) this.error = message(listed.error);
      for (const [dir, list] of listed.entries) if (dir === "" || this.open.has(dir)) this.entries.set(dir, list);
    }
    this.invalidateRows();
    this.cursor = rel;
    const i = this.rows().findIndex(r => r.path === rel);
    if (i >= 0) this.scroll.scroll_to_item(i);
    this.handle.focus();
    cx.notify();
  }

  // ---- keyboard ----

  key(e, cx) {
    const k = e.key_char === "G" ? "shift-g" : e.keystroke;
    if (this.typing) return this.typingKey(k, cx);
    const list = this.view === "search" ? "search" : this.findQuery ? "find" : "tree";
    if (this.jump) return this.jumpKey(k, cx);
    if (this.pending === "g") return this.gotoKey(list, k, cx);
    if (list === "tree") return this.treeKey(k, e, cx);
    return this.listKey(list, k, e, cx);
  }

  // After `g`, like Helix's goto mode: gg the top, ge the end, gw jump labels. Any other key cancels.
  gotoKey(list, k, cx) {
    this.pending = null;
    if (k === "g") this.goEdge(list, false);
    else if (k === "e") this.goEdge(list, true);
    else if (k === "w") this.startJump(list);
    cx.stop_propagation();
    cx.notify();
  }

  goEdge(list, end) {
    if (list !== "tree") return this.move(list, end ? Infinity : -Infinity);
    const rows = this.rows();
    if (!rows.length) return;
    const i = end ? rows.length - 1 : 0;
    this.cursor = rows[i].path;
    this.scroll.scroll_to_item(i);
  }

  /** gw: labels the tree or Find files rows on screen. Search results vary in height, so not there. */
  startJump(list) {
    if (list === "search") return;
    const count = list === "tree" ? this.rows().length : this.frows.length;
    if (!count) return;
    const scroll = list === "tree" ? this.scroll : this.fscroll;
    const [first, last] = this.visibleRange(scroll, count);
    const labels = jumpLabels(last - first + 1), at = new Map(), byIndex = new Map();
    labels.forEach((l, n) => { at.set(l, first + n); byIndex.set(first + n, l); });
    this.jump = { list, at, byIndex, typed: "" };
  }

  /** The rows at least half on screen. The list holds only rows, so no note or padding is above them. */
  visibleRange(scroll, count) {
    const fallback = [0, Math.min(count, JUMP_ALPHABET.length) - 1];
    if (typeof scroll.offset !== "function") return fallback;
    const y = scroll.offset().y, h = scroll.viewport_size().height;
    if (!(h > 0)) return fallback;
    const first = clamp(Math.ceil((y - ROW_H / 2) / ROW_H), count - 1);
    const last = clamp(Math.floor((y + h - ROW_H / 2) / ROW_H), count - 1);
    return [first, Math.max(first, last)];
  }

  jumpKey(k, cx) {
    const jump = this.jump, typed = jump.typed + k;
    const hits = /^[a-z]$/.test(k) ? [...jump.at.keys()].filter(l => l.startsWith(typed)) : [];
    if (hits.length === 1 && hits[0] === typed) {
      this.jump = null;
      const i = jump.at.get(typed);
      if (jump.list === "find") { this.fsel = clamp(i, this.frows.length - 1); this.fscroll.scroll_to_item(this.fsel); }
      else { const row = this.rows()[i]; if (row) { this.cursor = row.path; this.scroll.scroll_to_item(i); } }
    } else if (hits.length) jump.typed = typed;
    else this.jump = null;  // Esc or a key that is no label
    cx.stop_propagation();
    cx.notify();
  }

  /** The gw label still to type on row `i` of `list`, or null. */
  labelFor(list, i) {
    const l = this.jump?.list === list ? this.jump.byIndex.get(i) : null;
    return l && l.startsWith(this.jump.typed) ? l.slice(this.jump.typed.length) : null;
  }

  // Keys while an input has the keyboard: letters type; these move through the results.
  typingKey(k, cx) {
    const list = this.typing === "find" ? "find" : "search";
    switch (k) {
      case "down": case "ctrl-n": this.move(list, 1); break;
      case "up": case "ctrl-p": this.move(list, -1); break;
      case "pagedown": this.move(list, 15); break;
      case "pageup": this.move(list, -15); break;
      case "escape": this.back(); break;
      case "alt-c": if (list !== "search") return; this.toggleOpt("caseSensitive", cx); break;
      case "alt-w": if (list !== "search") return; this.toggleOpt("wholeWord", cx); break;
      case "alt-r": if (list !== "search") return; this.toggleOpt("regex", cx); break;
      default: return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  // Keys on a Find files or Search list that has the keyboard (not its input).
  listKey(list, k, e, cx) {
    const count = list === "find" ? this.frows.length : this.resultRows().length;
    switch (k) {
      case "j": case "down": this.move(list, 1); break;
      case "k": case "up": this.move(list, -1); break;
      case "g": this.pending = "g"; break;
      case "home": this.move(list, -count); break;
      case "shift-g": case "end": this.move(list, count); break;
      case "ctrl-d": case "pagedown": this.move(list, 15); break;
      case "ctrl-u": case "pageup": this.move(list, -15); break;
      case "enter": case "l": case "right": this.activate(list, true, cx); break;
      case "o": this.activate(list, false, cx); break;
      case "h": case "left": {
        const r = list === "find" ? this.frows[this.fsel] : null;
        if (r?.dir && !this.fclosed.has(r.path)) this.toggleFiltered(r.path);
        else if (r && parentOf(r.path)) this.fsel = clamp(this.frows.findIndex(x => x.path === parentOf(r.path)), this.frows.length - 1);
        else return;
        break;
      }
      case "/": this.startFind(cx, e.key_char); break;
      case "?": case "shift-/": this.startSearch(cx, e.key_char); break;
      case "escape": case "q": this.back(); break;
      default: return;
    }
    cx.stop_propagation();
    cx.notify();
  }

  treeKey(k, e, cx) {
    const rows = this.rows(), at = rows.findIndex(r => r.path === this.cursor);
    // No cursor yet (or its row is gone): the first key that moves lands on the top row.
    let i = Math.max(0, at);
    const row = rows[i];
    const move = n => {
      if (!rows.length) return;
      i = clamp(n, rows.length - 1);
      this.cursor = rows[i].path;
      this.scroll.scroll_to_item(i);
    };
    switch (k) {
      case "j": case "down": move(at < 0 ? 0 : i + 1); break;
      case "k": case "up": move(at < 0 ? 0 : i - 1); break;
      case "g": this.pending = "g"; break;
      case "home": move(0); break;
      case "shift-g": case "end": move(rows.length - 1); break;
      case "ctrl-d": case "pagedown": move(at < 0 ? 0 : i + 15); break;
      case "ctrl-u": case "pageup": move(at < 0 ? 0 : i - 15); break;
      case "l": case "right":
        if (!row) break;
        if (!row.dir) this.openFile(row.path, true, cx);
        else if (!this.open.has(row.path)) this.toggle(row.path, cx);
        else move(i + 1);
        break;
      case "enter": if (row) row.dir ? this.toggle(row.path, cx) : this.openFile(row.path, true, cx); break;
      case "o": if (row && !row.dir) this.openFile(row.path, false, cx); break;
      case "h": case "left":
        if (!row) break;
        if (row.dir && this.open.has(row.path)) this.toggle(row.path, cx);
        else if (parentOf(row.path)) move(rows.findIndex(r => r.path === parentOf(row.path)));
        break;
      case "/": this.startFind(cx, e.key_char); break;
      case "?": case "shift-/": this.startSearch(cx, e.key_char); break;
      case ".": this.showHidden = !this.showHidden; this.invalidateRows(); break;
      case "r": this.refresh(cx); break;
      case "escape": case "q": this.router.focusEditor(); break;
      default: return;  // anything else (Herdr's own keys) passes through
    }
    cx.stop_propagation();
    cx.notify();
  }

  // ---- view (modelled on Orca's right sidebar Files pane) ----

  /** Text with some ranges highlighted, as a row of runs. */
  spans(text, ranges, t, color) {
    const out = [];
    let at = 0;
    for (const [s, e] of ranges) {
      if (s > at) out.push(div().flex_none().child(text.slice(at, s)));
      if (e > s) out.push(div().flex_none().text_color(t.foreground).bg(alpha(t.ansi3, 0.3)).rounded(2).child(text.slice(s, e)));
      at = Math.max(at, e);
    }
    if (at < text.length) out.push(div().flex_none().child(text.slice(at)));
    return h_flex().min_w(0).overflow_hidden().text_color(color).children(out);
  }

  markColor(mark, t) {
    return mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3;
  }

  /** One row of the tree or of the Find files matches: chevron, folder or file icon, name, git mark. */
  /** `label`: its gw label, drawn over the start of the name like Helix's; `jumping` dims the rest. */
  nodeRow(r, { id, open, selected, active, hits, label, jumping }, t) {
    const abs = `${this.root}/${r.path}`, mark = this.marks[abs], dirty = r.dir && this.dirty.has(abs);
    const color = jumping ? t.muted : mark ? this.markColor(mark, t) : dirty ? t.ansi3 : t.foreground;
    const name = label ? h_flex().min_w(0).overflow_hidden()
        .child(div().flex_none().font_semibold().text_color(t.accent).child(label))
        .child(div().min_w(0).truncate().text_color(color).child(r.name.slice(label.length)))
      : hits?.length && !jumping ? this.spans(r.name, hits, t, color)
      : div().min_w(0).truncate().text_color(color).child(r.name);
    return h_flex().id(id).h(ROW_H).flex_none().w_full().pl(8 + r.depth * 16).pr(8).gap(4).items_center()
      .rounded(4).border_1().border_color(selected ? t.border : CLEAR).cursor_pointer().text_size(12)
      .when(selected, el => el.bg(active ? t.selected : t.hover))
      .when(!selected, el => el.hover(s => s.bg(t.hover)))
      .drag_paths([abs], { on: this.on })
      .child(r.dir ? svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.muted) : div().size(12).flex_none())
      .child(svg(ICON(r.dir ? (open ? "folder-open" : "folder") : "file")).size(12).flex_none().text_color(t.muted))
      .child(name)
      .when(Boolean(mark) || dirty, el => el.child(div().ml_auto().mr(8).flex_none().text_size(10).font_semibold()
        .text_color(color).child(mark || "•")));
  }

  /** `first`: the top row while focused with no cursor, where the first key lands. */
  treeRow(r, i, t, active, first) {
    return this.nodeRow(r, {
      id: `row-${r.path}`, open: this.open.has(r.path), selected: first || r.path === this.cursor, active,
      label: this.labelFor("tree", i), jumping: this.jump?.list === "tree",
    }, t);
  }

  foundRow(r, i, t, active) {
    return this.nodeRow(r, {
      id: `found-${r.path}`, open: r.dir && !this.fclosed.has(r.path), selected: i === this.fsel, active, hits: r.hits,
      label: this.labelFor("find", i), jumping: this.jump?.list === "find",
    }, t);
  }

  /** A tree row's click, from the virtual list's `on_item_click` (keyed by row path). */
  clickTree(path, cx) {
    this.jump = this.pending = null;
    this.cursor = path;
    this.handle.focus();
    const row = this.rows().find(r => r.path === path);
    if (row?.dir) this.toggle(path, cx); else if (row) this.openFile(path, true, cx);
    cx.notify();
  }

  /** A Find files row's click, from its virtual list's `on_item_click` (keyed by row path). */
  clickFound(path, cx) {
    this.jump = this.pending = null;
    const i = this.frows.findIndex(r => r.path === path);
    if (i < 0) return;
    const row = this.frows[i];
    this.fsel = i;
    if (row.dir) this.toggleFiltered(path); else this.openFile(path, true, cx);
    cx.notify();
  }

  /** A virtual row area's shared wiring (P2): the list — `sizes` is one height or one per row —
   *  its paired scrollbar, and clicks keyed by row, inside `area`. */
  virtualRows(area, { id, rows, sizes, scroll, onClick, build }) {
    return area
      .child(v_virtual_list(id, rows.length, sizes,
        i => rows[i]?.key ?? rows[i]?.path ?? String(i), build)
        .size_full().track_scroll(scroll)
        .on_item_click((key, cx) => onClick(key, cx)))
      .child(Scrollbar.vertical(id).absolute().inset_0());
  }

  /** The tree or Find files rows as a virtual list: only the visible range is built (P2). */
  rowList(kind, rows, t, active, first, scroll) {
    const id = `herdr-explorer-${kind}-rows`;
    return this.virtualRows(div().relative().flex_1().min_h(0).px(4).py(LIST_PAD), {
      id, rows, sizes: ROW_H, scroll,
      onClick: (key, cx) => (kind === "tree" ? this.clickTree(key, cx) : this.clickFound(key, cx)),
      build: range => rows.slice(range.start, range.end).map((r, n) => {
        const i = range.start + n;
        return kind === "tree" ? this.treeRow(r, i, t, active, first && i === 0)
          : this.foundRow(r, i, t, active);
      }),
    });
  }

  /** The search result rows as a virtual list of two heights: a file row, then its match rows. */
  resultList(rows, t, active) {
    const id = "herdr-explorer-search-rows";
    return this.virtualRows(div().relative().flex_1().min_h(0).pb(LIST_PAD), {
      id, rows, sizes: this.resultSizes(), scroll: this.rscroll,
      onClick: (key, cx) => this.clickResult(key, cx),
      build: range => rows.slice(range.start, range.end)
        .map((r, n) => this.resultRow(r, range.start + n, t, active)),
    });
  }

  /** A search result row's click, from its virtual list's `on_item_click` (keyed by row). */
  clickResult(key, cx) {
    this.jump = this.pending = null;
    const rows = this.resultRows(), i = rows.findIndex(r => r.key === key);
    if (i < 0) return;
    this.ssel = i;
    const row = rows[i];
    if (row.kind === "file") this.collapse(row.path); else this.openFile(row.path, true, cx, row);
    cx.notify();
  }

  resultRow(r, i, t, active) {
    const selected = i === this.ssel;
    const base = h_flex().id(`result-${i}`).w_full().flex_none().items_center().gap(4).cursor_pointer()
      .when(selected, el => el.bg(active ? t.selected : t.hover)).when(!selected, el => el.hover(s => s.bg(t.hover)));
    if (r.kind === "file") {
      const open = !this.collapsed.has(r.path), dir = parentOf(r.path);
      return div().w_full().flex_none().pt(6).child(base.h(22).px(8)
        .drag_paths([`${this.root}/${r.path}`], { on: this.on })
        .tooltip(r.path)
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.muted))
        .child(svg(ICON("file")).size(14).flex_none().text_color(t.muted))
        .child(h_flex().flex_1().min_w(0).items_center().overflow_hidden().text_size(12)
          .child(div().flex_none().text_color(t.foreground).child(baseOf(r.path)))
          .when(Boolean(dir), el => el.child(div().ml(6).min_w(0).truncate().text_size(11).text_color(t.muted).child(dir))))
        .child(div().flex_none().px(6).rounded(999).bg(alpha(t.hover, 0.8)).text_size(10).text_color(t.muted).child(String(r.count))));
    }
    // Like Orca: the indent goes, and at most 26 characters before the match stay.
    const first = r.ranges[0]?.[0] ?? 0;
    let before = r.text.slice(0, first).trimStart();
    if (before.length > 26) before = "…" + before.slice(before.length - 26);
    const shown = before + r.text.slice(first), shift = before.length - first;
    const ranges = r.ranges.map(([s, e]) => [Math.max(0, s + shift), Math.max(0, e + shift)]);
    return base.min_h(18).py(1).pl(28).pr(8)
      .child(div().flex_none().text_size(10).text_color(t.muted).child(String(r.line)))
      .child(div().flex_1().min_w(0).overflow_hidden().text_size(12).child(this.spans(shown, ranges, t, t.muted)));
  }

  /** A ghost icon button: the toolbar's, and the filters toggle. */
  iconButton(id, icon, about, fn, t, disabled = false) {
    return h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6).text_color(t.muted)
      .tooltip(about)
      .when(disabled, el => el.opacity(0.5))
      .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { fn(cx); cx.notify(); }))
      .child(svg(ICON(icon)).size(12));
  }

  /** Match case, whole word, regex: icons inside the search field. */
  toggleButton(id, icon, on, about, fn) {
    const t = theme();
    return h_flex().id(id).size(18).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
      .when(on, el => el.bg(t.selected).text_color(t.foreground))
      .when(!on, el => el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)))
      .tooltip(about)
      .on_click((_e, cx) => { fn(cx); cx.notify(); })
      .child(svg(ICON(icon)).size(14));
  }

  field(input, name, icon, t, extra, height = 32) {
    return h_flex().h(height).flex_none().px(8).gap(4).items_center().rounded(6).border_1()
      .border_color(this.typing === name ? t.dim : t.border).bg(alpha(t.input, 0.5))
      .when(Boolean(icon), el => el.child(svg(ICON(icon)).size(14).flex_none().text_color(t.muted)))
      .child(Input.new(input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .when(Boolean(extra), el => el.children(extra));
  }

  clearButton(id, about, fn, t) {
    return h_flex().id(id).flex_none().p(2).rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
      .tooltip(about).on_click((_e, cx) => { fn(cx); cx.notify(); }).child(svg(ICON("x")).size(12));
  }

  spinner(t) {
    return svg(ICON("loader-circle")).size(12).flex_none().text_color(t.muted);
  }

  toolbar(t) {
    const target = this.router.target();
    const where = target ? `Opens in ${target.name || "Helix"} · ${target.terminal}` : "No Helix pane: opening a file starts one";
    const more = Popover.new("explorer-more").anchor("top_right").open(this.menuOpen)
      .on_open_change((v, cx) => { this.menuOpen = v; cx.notify(); })
      .trigger(h_flex().id("explorer-more-button").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(this.menuOpen ? t.foreground : t.muted).when(this.menuOpen, el => el.bg(t.hover))
        .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("More Explorer Actions")
        .child(svg(ICON("ellipsis")).size(12)))
      .content(v_flex().id("explorer-more-menu").mt(4).p(4).min_w(192).rounded(8).bg(t.popover ?? t.raised)
        .border_1().border_color(t.border).shadow_md().text_size(12)
        .child(h_flex().id("explorer-dotfiles").h(32).px(8).gap(8).items_center().rounded(4).cursor_pointer()
          .text_color(t.foreground).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => { this.showHidden = !this.showHidden; this.invalidateRows(); this.menuOpen = false; cx.notify(); })
          .child(div().size(14).flex_none().when(this.showHidden, el => el.child(svg(ICON("check")).size(14).text_color(t.foreground))))
          .child(div().flex_1().child("Show Dotfiles"))
          .child(div().text_size(11).text_color(t.dim).child("."))));
    return h_flex().h(32).min_h(32).flex_none().px(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("explorer-root").flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground)
        .tooltip(this.root ? `${this.root}\n${where}` : where)
        .child(this.root?.split("/").pop() || "Explorer"))
      .child(this.iconButton("explorer-collapse", "list-collapse", "Collapse All", () => this.collapseAll(), t, this.open.size === 0))
      .child(this.iconButton("explorer-refresh", this.loading ? "loader-circle" : "refresh-cw", "Refresh Explorer (r)", cx => this.refresh(cx), t, !this.root))
      .child(more);
  }

  /** Names | Contents, as Orca's segmented switch. */
  viewSwitch(t) {
    const segment = (id, label, on, about, go) => h_flex().id(id).flex_1().min_w(0).h(24).px(8).items_center().justify_center()
      .rounded(6).text_size(12).font_medium().cursor_pointer().tooltip(about)
      .when(on, el => el.bg(t.selected).text_color(t.foreground))
      .when(!on, el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
      .on_click((_e, cx) => { if (!on) go(cx); cx.notify(); })
      .child(label);
    const typing = Boolean(this.typing);
    return h_flex().flex_none().p(2).gap(4).rounded(6).bg(t.hover)
      .child(segment("view-names", "Names", this.view === "tree", "Filter files by name (/)", cx => {
        this.view = "tree";
        if (typing) this.findInput.focus(); else this.handle.focus();
        this.ensureFiles(cx);
      }))
      .child(segment("view-contents", "Contents", this.view === "search", "Search file contents (?)", cx => {
        this.view = "search";
        if (typing) this.searchInput.focus(); else this.handle.focus();
        if (this.searchInput.value() && !this.results) this.scheduleSearch(cx);
      }));
  }

  findField(t) {
    const extra = [];
    if (this.findQuery && this.files.loading) extra.push(this.spinner(t));
    if (this.findQuery) extra.push(this.clearButton("find-clear", "Clear file filter", () => { this.clearFind(); this.handle.focus(); }, t));
    return this.field(this.findInput, "find", "list-filter", t, extra);
  }

  searchField(t) {
    const o = this.opts, extra = [];
    if (this.searching) extra.push(this.spinner(t));
    if (this.searchInput.value()) extra.push(this.clearButton("search-clear", "Clear search", cx => {
      this.searchInput.set_value(""); this.replaceResults(null); this.searchError = null; this.scheduleSearch(cx);
    }, t));
    extra.push(
      this.toggleButton("opt-case", "case-sensitive", o.caseSensitive, "Match Case (alt-c)", cx => this.toggleOpt("caseSensitive", cx)),
      this.toggleButton("opt-word", "whole-word", o.wholeWord, "Match Whole Word (alt-w)", cx => this.toggleOpt("wholeWord", cx)),
      this.toggleButton("opt-regex", "regex", o.regex, "Use Regular Expression (alt-r)", cx => this.toggleOpt("regex", cx)),
    );
    return this.field(this.searchInput, "search", "search", t, extra);
  }

  /** Files to include / exclude, folded behind the ellipsis like Orca's search details. */
  searchFilters(t) {
    const active = Boolean(this.includeInput.value().trim()) + Boolean(this.excludeInput.value().trim());
    const label = text => div().text_size(11).text_color(t.muted).child(text);
    return v_flex().flex_none()
      .child(h_flex().h(24).gap(4).items_center()
        .child(div().flex_1().min_w(0).when(this.opts.details, el => el.child(label("files to include"))))
        .when(active > 0, el => el.child(div().flex_none().text_size(11).text_color(t.muted).child(`${active} active`)))
        .child(this.iconButton("opt-details", "ellipsis", "Toggle search details", cx => this.toggleOpt("details", cx), t)))
      .when(this.opts.details, el => el.child(v_flex().gap(8).pb(8).pt(4)
        .child(this.field(this.includeInput, "include", null, t, null, 28))
        .child(v_flex().gap(4).child(label("files to exclude")).child(this.field(this.excludeInput, "exclude", null, t, null, 28)))));
  }

  /** The note above the tree or Find files rows, or null. */
  listNote(list) {
    if (list === "find") return this.files.error ? this.files.error
      : this.frows.length ? (this.found.length >= MAX_FILE_RESULTS ? `Best ${MAX_FILE_RESULTS} matches: keep typing` : null)
      : this.files.loading ? "Listing files…" : "No files match this filter";
    const rows = this.rows();
    return this.error || (rows.length ? (rows.length >= TOTAL ? "Showing the first 5,000 entries" : null)
      : this.loading ? "Loading…" : this.root ? "Empty folder" : "Focus a terminal to pick a folder");
  }

  /** At least a row tall, so a one-line note above rows shifts them by exactly ROW_H (see visibleRange). */
  note(text, t, color) {
    return div().flex_none().min_h(ROW_H).px(8).py(4).text_size(12).text_color(color ?? t.muted).child(text);
  }

  render(cx) {
    this.follow(cx);
    const t = theme(), active = this.handle.is_focused() || Boolean(this.typing);
    if (!this.handle.is_focused() && (this.pending || this.jump)) this.pending = this.jump = null;
    const mode = this.view === "search" ? "search" : this.findQuery ? "find" : "tree";
    const body = [];
    if (mode === "tree") {
      const rows = this.rows(), note = this.listNote("tree");
      const first = active && !rows.some(r => r.path === this.cursor);  // no cursor: the top row is it
      body.push(v_flex().id("herdr-explorer-tree").flex_1().min_h(0)
        .when(Boolean(note), el => el.child(this.note(note, t, this.error ? t.ansi1 : null)))
        .child(this.rowList("tree", rows, t, active, first, this.scroll)));
    } else if (mode === "find") {
      const note = this.listNote("find");
      body.push(v_flex().id("herdr-explorer-found").flex_1().min_h(0)
        .when(Boolean(note), el => el.child(this.note(note, t, this.files.error ? t.ansi1 : null)))
        .child(this.rowList("find", this.frows, t, active, false, this.fscroll)));
    } else {
      const res = this.results, rows = this.resultRows();
      if (!this.searchError && res && (rows.length || res.truncated)) {
        const n = (count, one) => `${count.toLocaleString()} ${one}${count === 1 ? "" : "s"}`;
        body.push(div().flex_none().px(8).py(4).text_size(11).text_color(t.muted).border_b(1).border_color(t.border)
          .child(`${n(res.total, "result")} in ${n(res.files.length, "file")}${res.truncated ? " (results truncated)" : ""}`));
      }
      body.push(v_flex().id("herdr-explorer-results").flex_1().min_h(0)
        .when(Boolean(this.searchError), el => el.child(div().p(8).text_size(12).text_color(t.ansi1).child(this.searchError)))
        .when(!this.searchError && res && !res.total, el => el.child(this.note("No results", t)))
        .when(!this.searchError && rows.length > 0, el => el.child(this.resultList(rows, t, active))));
    }
    return v_flex().id("herdr-explorer").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(active ? t.accent : t.border)
      .text_color(t.foreground).text_size(12)
      .child(this.toolbar(t))
      .child(v_flex().flex_none().px(8).py(8).gap(8).border_b(1).border_color(t.border)
        .child(this.viewSwitch(t))
        .child(mode === "search" ? this.searchField(t) : this.findField(t))
        .when(mode === "search", el => el.child(this.searchFilters(t))))
      .children(body)
      .when(Boolean(this.pending || this.jump), el => el.child(div().flex_none().px(8).py(4).border_t(1).border_color(t.border)
        .text_size(11).text_color(t.muted)
        .child(this.jump ? "Type a label to jump · Esc cancels"
          : mode === "search" ? "g  g top · e end" : "g  g top · e end · w jump to a row")));
  }
}
