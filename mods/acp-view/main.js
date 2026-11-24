// Claude Code over ACP in a pane of its own: Markdown, Mermaid diagrams and
// images rendered natively, tool calls as cards, permission prompts as buttons,
// Claude's questions (AskUserQuestion, as ACP form elicitations) as a form
// docked above the composer.
//
// The pane isn't tied to a terminal. It owns one session at a time, in its
// folder: a new one, or any earlier Claude Code session there (Sessions).
//
// Two ways this mod runs:
//   launcher  `mod.open:acp-view` (a key): splits the focused pane with a new
//             ACP pane in its folder, then closes itself.
//   pane      props {id, cwd, tab}. Its folder, session id and bridge live in
//             this copy's localStorage, so a reload or an app restart
//             reconnects to the bridge, or resumes the session in a new one.
//   new tab   props {id, cwd, adoptTab: true} from `tab.new {mod: "acp-view"}`
//             (factory-new-menu). A mod pane isn't told its tab, so it waits
//             until it is the shown tab's only, focused pane, keeps that tab
//             id in its store, and only then starts the bridge with its labels.
//             Its bridge is detached: no pane; factory-agents lists it.
//
// The bridge runs in an hc terminal with a pane in this tab (link.js), so the
// session is an hc agent: it is in the Agents sidebar, and agents Claude starts
// with `hc run` are its sub-agents and report to it. The header shows its address.
//
// Key:  keys.json  "ctrl-shift-a": "mod.open:acp-view"

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle, Popover } from "gpui-base";
import { theme, props, focused, home, checking, exec, appHome, nextCommand, settings, spaces, agents, terminals, panes, notify, playSound, closeOverlay, run, shared, setShared, writeTextFile } from "herdr";
import { Link } from "./link.js";
import { Store } from "./store.js";
import { Transcript } from "./transcript.js";
import { segments, hashKey } from "./segments.js";
import { slashMatches, completion } from "./slash.js";
import { initialPicks, pick, formContent, missing, answerLines } from "./questions.js";

const SLASH_KEYS = [
  ["up", "acp_slash_up"], ["ctrl-p", "acp_slash_up"],
  ["down", "acp_slash_down"], ["ctrl-n", "acp_slash_down"],
  ["tab", "acp_slash_complete"], ["escape", "acp_slash_close"],
];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const KIND = { read: "≡", edit: "✎", delete: "⌫", move: "⇄", search: "⌕", execute: "❯", think: "◌", fetch: "⇣", switch_mode: "⇆", other: "◇" };
const MAX_TOOL_TEXT = 6000;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export default class AcpView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.overlay && !p.id) {
      this.launcher = true;
      if (!checking()) cx.spawn(async () => this.openPane(p.overlay));
      return;
    }
    this.store = new Store();
    this.transcript = new Transcript();
    this.assets = new Map();
    this.toggled = new Set();
    this.attachments = [];
    this.follow = true;
    this.working = 0;
    this.size = null;
    this.busy = false;
    this.picker = null;
    this.menu = null;
    this.scroll = ScrollHandle.new();
    this.focus = cx.focus_handle();
    // The `/` panel: the highlighted command, and the text Esc closed it on.
    this.slashIndex = 0;
    this.slashClosed = null;
    this.slashScroll = ScrollHandle.new();
    // The open question's answers in progress: { id, picks, inputs, active, error }.
    this.ask = null;
    this.askFocus = cx.focus_handle();

    const st = this.store;
    this.cwd = st.get("cwd") ?? p.cwd ?? home();
    st.set("cwd", this.cwd);
    this.tab = st.get("tab") ?? p.tab ?? null;

    this.input = TextareaState.new({ placeholder: "Message Claude — Enter to send, Shift+Enter for a new line, drop images to attach" });
    this.input.set_auto_grow(1, 10);
    this.input.on("submit", (e, cx) => {
      if (e?.shift) return;
      const list = this.slashList();
      if (list?.length) this.chooseSlash(list[Math.min(this.slashIndex, list.length - 1)], true, cx);
      else this.submit(cx);
    });
    this.input.on("change", (_e, cx) => {
      this.slashIndex = 0;
      if (this.input.value() !== this.slashClosed) this.slashClosed = null;
      cx.notify();
    });
    // The `/` panel's keys. "AcpSlash > Input" matches at the textarea itself,
    // as deep as its own bindings, and a later binding wins a tie. Each context
    // is bound on its own: a list is all-or-nothing, so one predicate the app
    // can't parse must not take the other down with it.
    for (const context of ["AcpSlash > Input", "AcpSlash"]) {
      try {
        cx.bind_keys(SLASH_KEYS.map(([keystroke, action]) => ({ keystroke, action, context })));
      } catch {}
    }

    if (checking()) return;
    if (!this.tab && p.adoptTab) this.adoptTab(cx);
    else this.connect(cx);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus" || c?.name === "focus") this.input.focus();
        if (c?.name === "stop" || c === "stop") this.cancel();
        cx.notify();
      }
    });
    cx.timer.after(300, () => this.input.focus());
  }

  // A pane from `tab.new {mod}` isn't told its tab. Its tab is one whose only
  // pane is an acp-view pane (a started one also has its bridge's pane there)
  // and that no other ACP pane has claimed. Prefer the focused one; with several
  // and none focused, wait for them to settle. After 5 s, start without labels.
  adoptTab(cx, tries = 50) {
    const claimed = shared("acp-view.tabs") ?? {};
    const byTab = new Map();
    for (const x of panes()) byTab.set(x.tab, [...(byTab.get(x.tab) ?? []), x]);
    const free = [...byTab].filter(([tab, ps]) => ps.length === 1 && ps[0].mod === "acp-view" && !(tab in claimed)).map(([tab]) => tab);
    const f = focused()?.tab;
    const tab = free.includes(f) ? f : free.length === 1 || (tries <= 0 && free.length) ? free[0] : null;
    if (tab) {
      this.tab = tab;
      this.store.set("tab", tab);
      this.connect(cx);
    } else if (tries <= 0) {
      console.warn("acp-view: could not find this pane's new tab; the bridge starts without Herdr labels");
      this.connect(cx);
    } else cx.timer.after(100, () => this.adoptTab(cx, tries - 1));
  }

  // Which tab each ACP pane uses, so a new pane doesn't take one already in use.
  claimTab() {
    if (!this.tab) return;
    setShared("acp-view.tabs", { ...(shared("acp-view.tabs") ?? {}), [this.tab]: props()?.id ?? true });
  }

  connect(cx) {
    this.claimTab();
    const st = this.store;
    this.link = new Link({
      cwd: this.cwd,
      tab: this.tab,
      detached: Boolean(props()?.adoptTab || props()?.detached),
      store: st,
      resumeOf: () => st.get("session"),
      onEvent: (msg, cx) => this.onEvent(msg, cx),
      onState: () => {},
    }).start(cx);
  }

  // The pane going away (closed, a reload, quitting; a hidden tab keeps it):
  // the bridge ends 20 s later unless a view reconnects, but never mid-turn.
  // A pane that comes back resumes its session in a new bridge.
  async close() {
    if (this.launcher) return;
    this.link?.close();
  }

  // The launcher: a new ACP pane to the right of the focused pane, in its folder.
  async openPane(own) {
    try {
      // State from the old one-window-per-terminal version.
      if (shared("acp-view.state")) setShared("acp-view.state", null);
      if (shared("acp-view.windows")) setShared("acp-view.windows", null);
      const f = focused();
      const space = spaces().find((s) => s.id === f?.space);
      if (space?.machine) {
        notify({ title: "Rich view", body: "ACP panes run on this computer only for now.", level: "warning" });
        return;
      }
      // A mod pane (another ACP pane) has no folder: use a terminal's in the same tab.
      const near = panes().find((x) => x.tab === f?.tab && x.terminal && x.cwd)?.cwd;
      const cwd = f?.cwd || near || space?.folder || home();
      run("pane.split", { direction: "right", ...(f?.pane ? { pane: f.pane } : {}), mod: "acp-view", props: { id: newId(), cwd, tab: f?.tab ?? null } });
    } finally {
      closeOverlay(own);
    }
  }

  // --- sessions --------------------------------------------------------------------

  // A new session (null) or an earlier one, in place of the current one.
  switchTo(id, cx) {
    if (this.busy) return;
    if (this.working) {
      notify({ title: "Claude is working", body: "Stop the turn first (or let it finish).", level: "warning" });
      return;
    }
    this.busy = true;
    this.picker = null;
    this.syncAsk(null);
    cx.notify();
    cx.spawn(async (cx) => {
      await this.link?.shutdown();
      this.store.set("session", id);
      this.transcript.reset();
      this.attachments = [];
      this.follow = true;
      this.busy = false;
      this.connect(cx);
      cx.notify();
    });
  }

  togglePicker(cx) {
    if (this.picker) { this.picker = null; cx.notify(); return; }
    this.picker = { state: "loading", list: [] };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("node", [`${appHome()}/mods/acp-view/bridge/sessions.mjs`, this.cwd, "40"]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (!this.picker) return;
      try {
        if (r.code !== 0) throw new Error((r.stderr || "could not list sessions").trim());
        this.picker = { state: "ok", list: JSON.parse(r.stdout) };
      } catch (e) {
        this.picker = { state: "error", error: String(e.message ?? e) };
      }
      cx.notify();
    });
  }

  // A live Claude terminal on this computer that last ran this session, or null.
  // Turns taken there and here at once would split the session.
  terminalOf(session, recorded) {
    if (!session || !recorded) return null;
    const live = terminals().some((t) => t.address === recorded && t.state === "live");
    const claude = agents().find((a) => a.address === recorded)?.app === "claude-code";
    return live && claude ? recorded : null;
  }

  lookUpTerminal(session, cx) {
    this.recorded = null;
    if (session) cx.spawn(async (cx) => { this.recorded = await recordedTerminal(session); cx.notify(); });
  }

  // --- events from the bridge ---------------------------------------------------

  onEvent(msg, cx) {
    switch (msg.t) {
      case "hello":
        this.transcript.reset();
        for (const ev of msg.history ?? []) this.transcript.apply(ev);
        this.working = msg.working ?? 0;
        this.terminal = msg.terminal ?? null;
        this.lookUpTerminal(this.transcript.session?.sessionId, cx);
        break;
      case "asset":
        this.assets.set(msg.key, msg.error ? { state: "error", error: msg.error } : { state: "ok", path: msg.path, width: msg.width, height: msg.height });
        break;
      case "working":
        this.working = msg.working;
        break;
      case "session":
        this.transcript.apply(msg);
        this.lookUpTerminal(msg.sessionId, cx);
        this.reapplyConfig();
        break;
      default:
        this.transcript.apply(msg);
        this.attention(msg);
        // Only a session with a prompt in it has a transcript to load later.
        if (msg.t === "user" && this.transcript.session?.sessionId) this.store.set("session", this.transcript.session.sessionId);
    }
    this.syncAsk(this.transcript.pendingQuestion);
    if (this.follow) this.scrollToEnd();
  }

  scrollToEnd() {
    // The "end" sentinel: after the items (or after the empty-state card).
    this.scroll.scroll_to_item(Math.max(1, this.transcript.items.length));
  }

  // Herdr only alerts for agents it lists. When the bridge's terminal is one,
  // Herdr does it; else say it here when the person is looking at another tab.
  attention(msg) {
    if (focused()?.tab === this.tab) return;
    if (this.terminal && agents().some((a) => a.address === this.terminal)) return;
    const title = this.transcript.title ?? "Claude (ACP)";
    if (msg.t === "permission" || msg.t === "question") {
      playSound("blocked");
      const body = msg.t === "question" ? msg.message || "Claude has a question" : msg.toolCall?.title ?? "Permission requested";
      notify({ title: `${title} needs you`, body, level: "warning", action: this.tab ? { name: "tab.select", args: { id: this.tab } } : undefined });
    } else if (msg.t === "turn_end") {
      playSound("done");
      notify({ title: `${title} finished`, body: shortPath(this.cwd, home()), level: "success", action: this.tab ? { name: "tab.select", args: { id: this.tab } } : undefined });
    }
  }

  // --- actions --------------------------------------------------------------------

  submit(cx) {
    const text = this.input.value().replace(/\s+$/, "");
    if (!text && !this.attachments.length) return;
    if (!this.link?.send({ t: "prompt", text, images: this.attachments })) return;
    this.input.set_value("");
    this.attachments = [];
    this.follow = true;
    this.scrollToEnd();
    cx.notify();
  }

  cancel() {
    this.link?.send({ t: "cancel" });
  }

  // The commands the `/` panel offers for the composer's text, or null when it's closed.
  slashList() {
    const text = this.input.value();
    if (text === this.slashClosed) return null;
    return slashMatches(this.transcript.commands, text);
  }

  // Enter (run) sends a command that takes no input, or one whose whole name
  // is typed already; otherwise, and on Tab or a click, the name goes in the
  // composer for its arguments to follow.
  chooseSlash(c, run, cx) {
    if (run && (!c.input || this.input.value() === `/${c.name}`)) {
      this.input.set_value(`/${c.name}`);
      this.submit(cx);
      return;
    }
    const text = completion(c);
    this.input.set_value(text);
    this.input.set_selected_range({ start: text.length, end: text.length });
    this.input.focus();
    cx.notify();
  }

  // ↑/↓ (or Ctrl+P/Ctrl+N) move the highlight, Tab completes, Esc closes.
  // These come in as actions (SLASH_KEYS), not key events: the textarea's own
  // bindings (move the cursor, indent, unselect) run before any on_key_down
  // above it, so a key handler on the composer never sees these keys.
  slashAction(what, cx) {
    const list = this.slashList();
    if (!list?.length) return;
    const sel = Math.min(this.slashIndex, list.length - 1);
    if (what === "complete") this.chooseSlash(list[sel], false, cx);
    else if (what === "close") this.slashClosed = this.input.value();
    else {
      this.slashIndex = (sel + (what === "down" ? 1 : -1) + list.length) % list.length;
      this.slashScroll.scroll_to_item(this.slashIndex);
    }
    cx.notify();
  }

  permit(id, optionId) {
    this.link?.send({ t: "permit", id, optionId });
  }

  // --- questions (form elicitations) -----------------------------------------------

  // Keeps this.ask on the question that is open (q, or null): a new one gets
  // fresh picks and text boxes and the keyboard; an answered one lets them go.
  syncAsk(q) {
    if (this.ask && this.ask.id === q?.id) return;
    const hadOne = Boolean(this.ask);
    for (const s of this.ask?.inputs.values() ?? []) s.release();
    this.ask = null;
    if (!q) {
      if (hadOne) this.input.focus();
      return;
    }
    const inputs = new Map();
    const box = (key, placeholder) => {
      const s = TextareaState.new({ placeholder });
      s.set_auto_grow(1, 4);
      s.on("submit", (e, cx) => { if (!e?.shift) this.askEnter(cx); });
      inputs.set(key, s);
    };
    for (const f of q.fields) {
      if (f.kind === "text" || f.kind === "number" || f.kind === "integer") box(f.key, f.description ?? (f.kind === "text" ? "Type your answer" : "A number"));
      if (f.other) box(f.other.key, f.other.description ?? "Type your own answer (optional)");
    }
    this.ask = { id: q.id, picks: initialPicks(q.fields), inputs, active: 0, error: null };
    this.askFocus.focus();
  }

  answerAsk(action, cx) {
    const q = this.transcript.pendingQuestion;
    const a = this.ask;
    if (!q || !a || a.id !== q.id) return;
    if (action === "accept") {
      const texts = {};
      for (const [k, s] of a.inputs) texts[k] = s.value();
      const content = formContent(q.fields, a.picks, texts);
      const miss = missing(q.fields, content);
      if (miss.length) {
        a.error = `Still needs an answer: ${miss.join(", ")}`;
        const first = q.fields.findIndex((f) => miss.includes(f.title ?? f.key));
        if (first >= 0) a.active = first;
        cx.notify();
        return;
      }
      this.link?.send({ t: "answer", id: q.id, action, content });
    } else this.link?.send({ t: "answer", id: q.id, action });
    cx.notify();
  }

  // One question per tab. Switching tabs gives the keyboard back to the form.
  askTab(i, cx) {
    const q = this.transcript.pendingQuestion;
    if (!this.ask || !q) return;
    this.ask.active = Math.max(0, Math.min(i, q.fields.length - 1));
    this.askFocus.focus();
    cx.notify();
  }

  // Enter: the next question's tab, or Submit on the last one.
  askEnter(cx) {
    const q = this.transcript.pendingQuestion;
    const a = this.ask;
    if (!q || !a) return;
    if (a.active < q.fields.length - 1) return this.askTab(a.active + 1, cx);
    this.answerAsk("accept", cx);
  }

  // Whether a question has an answer yet (a ✓ on its tab).
  askAnswered(f) {
    const a = this.ask;
    const v = a.picks[f.key];
    const typed = (key) => Boolean(a.inputs.get(key)?.value().trim());
    if (f.other && typed(f.other.key)) return true;
    if (f.kind === "multi") return Boolean(v?.length);
    if (f.kind === "single") return v !== undefined && v !== null;
    if (f.kind === "boolean") return true;
    return typed(f.key);
  }

  // Keys while the form itself (not one of its text boxes) has the keyboard:
  // 1–9 pick in the shown question (one choice moves on to the next tab),
  // ←/→ switch tabs, Enter goes to the next tab or submits, Esc skips.
  askKey(e, q, cx) {
    const a = this.ask;
    if (!a || !this.askFocus.is_focused()) return;
    const k = e.keystroke;
    const f = q.fields[a.active];
    if (/^[1-9]$/.test(k) && f?.options.length) {
      const o = f.options[Number(k) - 1];
      if (!o) return;
      pick(a.picks, f, o.value);
      a.error = null;
      if (f.kind === "single" && a.picks[f.key] !== undefined && a.active < q.fields.length - 1) return this.askTab(a.active + 1, cx);
    } else if (k === "right" || k === "l") return this.askTab(a.active + 1, cx);
    else if (k === "left" || k === "h") return this.askTab(a.active - 1, cx);
    else if (k === "enter") return this.askEnter(cx);
    else if (k === "escape") return this.answerAsk("decline", cx);
    else return;
    cx.notify();
  }

  cycleMode() {
    const modes = this.transcript.session?.modes?.availableModes ?? [];
    if (!modes.length) return;
    const i = modes.findIndex((m) => m.id === this.transcript.mode);
    this.link?.send({ t: "mode", modeId: modes[(i + 1) % modes.length].id });
  }

  // Model and effort picks. The pane keeps them, so a new session (+ New, a
  // resumed one, a restarted bridge) runs with them too.
  setConfig(configId, value) {
    if (!this.link?.send({ t: "config", configId, value })) return;
    this.store.set("config", { ...(this.store.get("config") ?? {}), [configId]: value });
  }

  // A fresh session starts on Claude Code's defaults: send the pane's picks
  // that differ, model first (it changes the effort levels on offer).
  reapplyConfig() {
    const picks = this.store.get("config") ?? {};
    const order = ["model", "thought_level"];
    for (const cat of order) {
      const o = this.transcript.option(cat);
      const want = o && picks[o.id];
      if (want && want !== o.currentValue && o.choices.some((c) => c.value === want)) this.link?.send({ t: "config", configId: o.id, value: want });
    }
  }

  attach(paths) {
    for (const p of paths) if (/\.(png|jpe?g|gif|webp)$/i.test(p) && !this.attachments.includes(p)) this.attachments.push(p);
  }

  asset(key, request) {
    let a = this.assets.get(key);
    if (!a) {
      a = { state: "pending" };
      if (this.link?.send({ t: "render", key, ...request })) this.assets.set(key, a);
    }
    return a;
  }

  // --- drawing ----------------------------------------------------------------------

  render(cx) {
    if (this.launcher) return div();
    const t = theme();
    const items = this.transcript.items;
    const clash = this.clash(t);
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground).text_size(13.5)
      .track_focus(this.focus)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_drop((e, cx) => { this.attach(e.paths ?? []); cx.notify(); })
      .child(this.header(t))
      .when(Boolean(clash), (el) => el.child(clash))
      .child(v_flex().id("scroll").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_scroll_wheel((e, cx) => {
          if ((e.delta?.y ?? 0) > 0 && this.follow) { this.follow = false; cx.notify(); }
        })
        .px(22).pt(16).pb(10).gap(14)
        .children(this.picker ? [this.sessions(t)] : [
          ...(items.length ? [] : [this.empty(t)]),
          ...items.map((it, i) => this.item(it, i, t)),
          div().id("end").h(2),
        ]))
      .when(!this.follow && !this.picker, (el) => el.child(h_flex().justify_center().pb(4)
        .child(h_flex().id("jump").px(10).py(3).rounded(10).bg(t.raised).border_1().border_color(t.border).text_size(11.5).text_color(t.muted)
          .cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.follow = true; this.scrollToEnd(); cx.notify(); })
          .child("↓ Latest"))))
      .child(this.composer(t));
  }

  header(t) {
    const tr = this.transcript;
    const state = this.busy ? "starting" : this.link?.state ?? "starting";
    const status = state === "error" ? `Reconnecting… ${this.link?.error ?? ""}`
      : tr.status ?? (state === "starting" ? "Starting…" : this.working ? "Working" : tr.exited ? "Exited" : "Ready");
    const modes = tr.session?.modes?.availableModes ?? [];
    const mode = modes.find((m) => m.id === tr.mode);
    const used = tr.usage?.used, size = tr.usage?.size;
    const folder = this.cwd.startsWith(home()) ? "~" + this.cwd.slice(home().length) : this.cwd;
    return h_flex().id("header").h(34).px(12).gap(10).items_center().bg(t.chrome).border_b_1().border_color(t.border).text_size(12)
      .child(div().text_color(t.accent).font_semibold().child("✻"))
      .child(div().font_semibold().truncate().max_w(320).child(tr.title ?? "Claude"))
      .child(div().text_color(t.dim).truncate().flex_1().min_w(0).child(folder))
      .when(Boolean(used && size), (el) => el.child(div().text_color(t.dim).child(`${fmtK(used)} / ${fmtK(size)}`)))
      .when(Boolean(tr.cost), (el) => el.child(div().text_color(t.dim).child(`$${tr.cost.amount.toFixed(2)}`)))
      .when(Boolean(mode), (el) => el.child(chip("mode", mode.name, t, () => this.cycleMode(), mode.description)))
      .children(["model", "thought_level"].map((cat) => this.configMenu(tr.option(cat), t)).filter(Boolean))
      .when(Boolean(this.terminal), (el) => el.child(chip("hc", this.terminal, t, () => (panes().some((x) => x.terminal === this.terminal) ? run("pane.focus", { terminal: this.terminal }) : run("terminal.peek", { terminal: this.terminal })), "This session's hc address: its terminal")))
      .child(h_flex().gap(5).items_center().text_color(state === "error" ? t.blocked : this.working ? t.working : t.muted)
        .when(Boolean(this.working) || state === "starting", (el) => el.child(div().frames(SPIN, 90).child(SPIN[0])))
        .child(div().truncate().max_w(220).child(status)))
      .child(chip("sessions", this.picker ? "✕ Sessions" : "Sessions", t, (_e, cx) => this.togglePicker(cx), "Resume an earlier session in this folder"))
      .child(chip("new", "+ New", t, (_e, cx) => this.switchTo(null, cx), "Start a new session in this folder"));
  }

  // A header chip that opens a list of a config option's choices.
  configMenu(o, t) {
    if (!o || !o.choices.length) return null;
    const label = o.current?.name ?? o.currentValue;
    const open = this.menu === o.id;
    return Popover.new(`cfg-${o.id}`).anchor("top_right").open(open)
      .on_open_change((v, cx) => { this.menu = v ? o.id : (this.menu === o.id ? null : this.menu); cx.notify(); })
      .trigger(chipFace(`cfg-${o.id}`, `${o.name}: ${label} ▾`, t, open))
      .content(v_flex().id(`cfg-${o.id}-list`).mt(4).p(4).min_w(220).max_h(420).overflow_y_scrollbar()
        .rounded(8).bg(t.popover ?? t.raised).border_1().border_color(t.border).shadow_md().text_size(12.5)
        .children(o.choices.map((c) => {
          const on = c.value === o.currentValue;
          return v_flex().id(`cfg-${o.id}-${c.value}`).px(10).py(5).rounded(5).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.menu = null; if (!on) this.setConfig(o.id, c.value); cx.notify(); })
            .child(h_flex().gap(8).items_center()
              .child(div().w(12).text_color(t.accent).child(on ? "✓" : ""))
              .child(div().text_color(on ? t.accent : t.foreground).child(c.name ?? c.value)))
            .when(Boolean(c.description), (el) => el.child(div().pl(20).text_size(11).text_color(t.dim).child(c.description)));
        })));
  }

  // Earlier Claude Code sessions in this folder, newest first.
  sessions(t) {
    const pk = this.picker;
    const current = this.store.get("session") ?? this.transcript.session?.sessionId;
    const box = v_flex().id("sessions").w_full().gap(2)
      .child(div().pb(6).text_size(11).text_color(t.dim).child("Resume a session in this folder"));
    if (pk.state === "loading") return box.child(h_flex().gap(6).text_size(12).text_color(t.dim).child(div().frames(SPIN, 90).child(SPIN[0])).child("Loading…"));
    if (pk.state === "error") return box.child(div().text_size(12).text_color(t.blocked).child(pk.error));
    if (!pk.list.length) return box.child(div().text_size(12).text_color(t.dim).child("No earlier sessions here."));
    return box.children(pk.list.map((s) => {
      const mine = s.id === current;
      const term = this.terminalOf(s.id, s.terminal);
      return h_flex().id(`ss-${s.id}`).px(10).py(6).gap(10).rounded(6).items_center().text_size(12.5)
        .when(!mine, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.switchTo(s.id, cx)))
        .child(div().flex_1().min_w(0).truncate().text_color(mine ? t.accent : t.foreground).child(s.title))
        .when(Boolean(term), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`open in ${term}`)))
        .child(div().text_size(11).text_color(t.dim).child(mine ? "this pane" : ago(s.modified)));
    }));
  }

  // Shown when this pane's session is also open in a live Claude terminal.
  clash(t) {
    const rec = this.terminalOf(this.transcript.session?.sessionId, this.recorded);
    if (!rec) return null;
    return div().id("clash").px(12).py(4).bg(t.raised).border_b_1().border_color(t.border).text_size(11.5).text_color(t.blocked)
      .child(`This session is also open in ${rec}: don't take turns in both, the conversation would split.`);
  }

  empty(t) {
    return v_flex().pt(40).gap(6).items_center().text_color(t.dim)
      .child(div().text_size(28).text_color(t.accent).child("✻"))
      .child(div().text_size(14).text_color(t.muted).child("Claude Code, rendered"))
      .child(div().text_size(12).child("Markdown, Mermaid diagrams and images show inline."));
  }

  item(it, i, t) {
    switch (it.kind) {
      case "user": return this.user(it, i, t);
      case "agent": return this.agent(it, i, t);
      case "thought": return this.thought(it, i, t);
      case "tool": return this.tool(it, i, t);
      case "permission": return this.permission(it, i, t);
      case "question": return this.question(it, i, t);
      case "plan": return this.plan(it, i, t);
      case "notice": return div().id(`n-${i}`).text_size(12).text_color(t.dim).child(it.text);
      case "error": return div().id(`e-${i}`).px(10).py(6).rounded(6).bg(t.raised).text_size(12).text_color(t.blocked).child(it.text);
      default: return div();
    }
  }

  user(it, i, t) {
    return h_flex().id(`u-${i}`).justify_end().child(
      v_flex().max_w(this.maxWidth() * 0.85).px(12).py(8).gap(6).rounded(10).bg(t.raised).border_1().border_color(t.border)
        .children(it.text ? segments(it.text).map((s, j) => this.segment(s, `u${i}-${j}`, t)) : [])
        .children(it.images.map((a, j) => this.picture(`ui-${i}-${j}`, a, t, 240))));
  }

  agent(it, i, t) {
    const segs = segments(it.text);
    return v_flex().id(`a-${i}`).gap(10).w_full()
      .children(segs.map((s, j) => this.segment(s, `${i}-${j}`, t)))
      .children(it.images.map((a, j) => this.picture(`ai-${i}-${j}`, a, t)));
  }

  segment(s, id, t) {
    if (s.kind === "md") return md(`md-${id}`, s.text);
    if (s.kind === "img") {
      const a = this.asset(`f:${s.src}`, { kind: "file", src: s.src });
      if (a.state === "ok") return this.picture(`img-${id}`, a, t);
      return div().id(`img-${id}`).text_size(12).text_color(a.state === "error" ? t.blocked : t.dim)
        .child(a.state === "error" ? `[image ${s.alt || s.src}: ${a.error}]` : `Loading ${s.alt || s.src}…`);
    }
    if (s.kind === "html") return this.htmlBlock(s, id, t);
    // mermaid
    const box = (inner) => v_flex().id(`mm-${id}`).w_full().p(8).rounded(8).bg(t.surface).border_1().border_color(t.border).gap(4)
      .child(div().text_size(10.5).text_color(t.dim).child("mermaid"))
      .child(inner);
    if (!s.closed) return box(h_flex().gap(6).text_size(12).text_color(t.dim).child(div().frames(SPIN, 90).child(SPIN[0])).child("Drawing diagram…"));
    const colors = mermaidColors(t);
    const a = this.asset(`m:${hashKey(s.src + JSON.stringify(colors))}`, { kind: "mermaid", src: s.src, colors });
    if (a.state === "ok") return box(this.picture(`mmi-${id}`, a, t, this.maxWidth() - 18, true));
    if (a.state === "error") return box(v_flex().gap(4)
      .child(div().text_size(12).text_color(t.blocked).child(`Could not draw this diagram: ${a.error}`))
      .child(md(`mms-${id}`, "```\n" + s.src + "\n```")));
    return box(h_flex().gap(6).text_size(12).text_color(t.dim).child(div().frames(SPIN, 90).child(SPIN[0])).child("Drawing diagram…"));
  }

  // ```html: drawn as native HTML text (structure, no CSS or scripts). Source
  // shows the code; Open shows the page with its CSS in the browser. While the
  // block is still being written it shows as code.
  htmlBlock(s, id, t) {
    const key = `hs-${id}`;
    const source = !s.closed || this.toggled.has(key);
    const btn = (bid, label, fn) => div().id(bid).px(6).h(18).rounded(4).flex().items_center()
      .text_size(10.5).text_color(t.dim).cursor_pointer().hover((e) => e.bg(t.hover).text_color(t.foreground))
      .on_click(fn).child(label);
    return v_flex().id(`ht-${id}`).w_full().p(8).rounded(8).bg(t.surface).border_1().border_color(t.border).gap(4)
      .child(h_flex().gap(4).items_center()
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child(s.closed ? "html" : "html · writing…"))
        .when(s.closed, (el) => el
          .child(btn(`hts-${id}`, source ? "Rendered" : "Source", (_e, cx) => { toggle(this.toggled, key); cx.notify(); }))
          .child(btn(`hto-${id}`, "Open", () => this.openHtml(s.src)))))
      .child(source
        ? md(`htc-${id}`, "````html\n" + s.src + "\n````")
        : TextView.html(`htv-${id}`, htmlText(s.src)).selectable(true));
  }

  // The block as a page in the browser: a content-named file next to the pictures.
  async openHtml(src) {
    const page = /<html[\s>]/i.test(src) ? src : `<!doctype html>\n<meta charset="utf-8">\n${src}\n`;
    const path = `${appHome()}/mods/acp-view-assets/${hashKey(page)}.html`;
    await writeTextFile(path, page, null).catch(() => {}); // already there: same content
    exec("xdg-open", [path]).catch(() => {});
  }

  // A picture at its natural size (rendered at 2x for diagrams), shrunk to fit.
  picture(id, a, t, maxW = this.maxWidth(), retina = false) {
    let w = a.width || 320, h = a.height || 240;
    if (retina) { w = w / 1; h = h / 1; }
    const scale = Math.min(1, maxW / w);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    return div().id(id).w(w).h(h).rounded(4).overflow_hidden().cursor_pointer()
      .on_click(() => { exec("xdg-open", [`${appHome()}/${a.path}`]).catch(() => {}); })
      .child(image(a.path).size_full());
  }

  thought(it, i, t) {
    const open = this.toggled.has(`th-${i}`);
    const first = it.text.trim().split("\n")[0] ?? "";
    return v_flex().id(`th-${i}`).gap(4).text_color(t.dim)
      .child(h_flex().id(`thh-${i}`).gap(6).text_size(12).cursor_pointer().hover((s) => s.text_color(t.muted))
        .on_click((_e, cx) => { toggle(this.toggled, `th-${i}`); cx.notify(); })
        .child(open ? "▾" : "▸").child(div().italic().child("Thinking")).when(!open, (el) => el.child(div().truncate().flex_1().min_w(0).child(first))))
      .when(open, (el) => el.child(div().pl(14).border_l_1().border_color(t.border).child(md(`thm-${i}`, it.text))));
  }

  tool(it, i, t) {
    const hasDiff = (it.content ?? []).some((c) => c.type === "diff");
    const key = it.toolCallId;
    const open = hasDiff !== this.toggled.has(key);
    const color = { completed: t.done, failed: t.blocked, in_progress: t.working, pending: t.dim }[it.status] ?? t.dim;
    const mark = it.status === "completed" ? "✓" : it.status === "failed" ? "✕" : null;
    const body = open ? this.toolBody(it, i, t) : null;
    return v_flex().id(`t-${i}`).w_full().rounded(8).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
      .child(h_flex().id(`th-${key}`).h(30).px(10).gap(8).items_center().text_size(12.5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { toggle(this.toggled, key); cx.notify(); })
        .child(div().w(14).text_color(t.accent).child(KIND[it.toolKind] ?? KIND.other))
        .child(div().flex_1().min_w(0).truncate().font_family(settings().font_family ?? "monospace").child(it.title || it.name || "Tool"))
        .child(mark ? div().text_color(color).child(mark) : div().text_color(color).frames(SPIN, 90).child(SPIN[0]))
        .child(div().text_color(t.dim).child(open ? "▾" : "▸")))
      .when(Boolean(body), (el) => el.child(v_flex().px(10).pb(8).pt(2).gap(6).border_t_1().border_color(t.border).children(body)));
  }

  toolBody(it, i, t) {
    const out = [];
    const cmd = it.rawInput?.command;
    if (cmd) out.push(md(`tc-${i}`, "```sh\n$ " + cmd + "\n```"));
    (it.content ?? []).forEach((c, j) => {
      if (c.type === "diff") {
        out.push(div().text_size(11.5).text_color(t.muted).child(`${c.isNew ? "new file " : ""}${shortPath(c.path, this.cwd)}`));
        out.push(md(`td-${i}-${j}`, "```diff\n" + c.unified.replace(/^(---|\+\+\+) .*\n?/gm, "") + "\n```"));
      } else if (c.type === "content") {
        const b = c.content ?? {};
        if (b.type === "image" && b.path) out.push(this.picture(`tim-${i}-${j}`, b, t));
        else if (b.type === "text" && b.text?.trim()) out.push(md(`tt-${i}-${j}`, fenced(b.text)));
      } else if (c.type === "terminal") {
        out.push(div().text_size(12).text_color(t.dim).child("(terminal output)"));
      }
    });
    if (!out.length || (out.length === 1 && cmd)) {
      if (typeof it.rawOutput === "string" && it.rawOutput.trim()) out.push(md(`to-${i}`, fenced(it.rawOutput)));
      else if (!cmd && it.rawInput && Object.keys(it.rawInput).length) out.push(md(`ti-${i}`, "```json\n" + JSON.stringify(it.rawInput, null, 2).slice(0, MAX_TOOL_TEXT) + "\n```"));
    }
    if (!out.length) out.push(div().text_size(12).text_color(t.dim).child("No output."));
    return out;
  }

  permission(it, i, t) {
    const answered = it.answer !== undefined;
    const chosen = it.options.find((o) => o.optionId === it.answer);
    const tc = it.toolCall ?? {};
    return v_flex().id(`p-${i}`).w_full().p(12).gap(8).rounded(8).border_1().border_color(answered ? t.border : t.blocked).bg(t.surface)
      .child(h_flex().gap(8).text_size(12.5)
        .child(div().text_color(t.blocked).child("⚑"))
        .child(div().font_semibold().child("Permission"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).font_family(settings().font_family ?? "monospace").child(tc.title ?? "")))
      .when(Boolean(tc.rawInput?.command), (el) => el.child(md(`pc-${i}`, "```sh\n$ " + tc.rawInput.command + "\n```")))
      .when(answered, (el) => el.child(div().text_size(12).text_color(t.dim).child(chosen ? `Answered: ${chosen.name}` : "Cancelled")))
      .when(!answered, (el) => el.child(h_flex().gap(6).flex_wrap().children(it.options.map((o) => {
        const allow = o.kind?.startsWith("allow");
        return h_flex().id(`po-${i}-${o.optionId}`).h(28).px(12).items_center().rounded(6).text_size(12).cursor_pointer()
          .bg(allow ? t.solid : t.raised).text_color(allow ? t.solid_foreground : t.foreground).border_1().border_color(allow ? t.solid : t.input)
          .hover((s) => s.opacity(0.85))
          .on_click(() => this.permit(it.id, o.optionId))
          .child(o.name);
      }))));
  }

  // The transcript's record of a question: where to answer it, then what was answered.
  question(it, i, t) {
    const answered = it.answer !== undefined;
    const card = v_flex().id(`q-${i}`).w_full().p(12).gap(6).rounded(8).border_1().border_color(answered ? t.border : t.blocked).bg(t.surface)
      .child(h_flex().gap(8).text_size(12.5).items_center()
        .child(div().text_color(answered ? t.accent : t.blocked).font_semibold().child("?"))
        .child(div().font_semibold().child(answered ? "Claude asked" : "Claude asks"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(it.fields.length > 1 ? `${it.fields.length} questions` : it.message)));
    if (!answered) return card.child(div().text_size(12).text_color(t.dim).child("Answer it below, above the message box."));
    return card.children(answerLines(it.fields, it.answer).map((l, j) => h_flex().id(`qa-${i}-${j}`).gap(8).text_size(12)
      .when(Boolean(l.title), (el) => el.child(div().flex_shrink_0().max_w(320).truncate().text_color(t.dim).child(l.title)))
      .child(div().flex_1().min_w(0).text_color(it.answer.action === "accept" ? t.foreground : t.dim).child(l.text))));
  }

  // The open question, docked above the composer like a popover. Several
  // questions get one tab each (✓ once answered); the shown one has its
  // options as rows (● one, ☑ several), an "Other" box, then Skip and
  // Back/Next or Submit.
  askPanel(q, t) {
    const a = this.ask;
    const n = q.fields.length;
    const several = n > 1;
    const last = a.active >= n - 1;
    const f = q.fields[a.active];
    return v_flex().id(`ask-${q.id}`).track_focus(this.askFocus).on_key_down((e, cx) => this.askKey(e, q, cx))
      .max_h(Math.max(240, Math.round((this.size?.height ?? 640) * 0.6))).overflow_y_scrollbar()
      .p(12).gap(10).rounded(8).border_1().border_color(t.blocked).bg(t.popover ?? t.raised).shadow_md().text_size(12.5)
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(t.blocked).font_semibold().child("?"))
        .child(div().font_semibold().child(several ? `Claude has ${n} questions` : "Claude asks"))
        .when(several, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${a.active + 1} of ${n}`))))
      .when(several, (el) => el.child(h_flex().id("ask-tabs").gap(2).flex_wrap().border_b_1().border_color(t.border)
        .children(q.fields.map((g, j) => {
          const on = j === a.active;
          const done = this.askAnswered(g);
          return h_flex().id(`askt-${j}`).px(10).py(5).gap(6).items_center().cursor_pointer()
            .border_b_2().border_color(on ? t.accent : t.popover ?? t.raised)
            .text_color(on ? t.foreground : t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.askTab(j, cx))
            .child(div().text_color(done ? t.done : t.dim).child(done ? "✓" : String(j + 1)))
            .child(div().max_w(160).truncate().when(on, (el) => el.font_semibold()).child(g.title ?? `Question ${j + 1}`));
        }))))
      .when(Boolean(q.message) && !several, (el) => el.child(md(`askm-${q.id}`, q.message)))
      .child(this.askField(q, f, a.active, t))
      .when(Boolean(a.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(a.error)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(several ? "1–9 pick · ←→ question · Enter next · Esc skip" : "1–9 pick · Enter submit · Esc skip"))
        .child(button("ask-skip", "Skip", t, false, (_e, cx) => this.answerAsk("decline", cx)))
        .when(several && a.active > 0, (el) => el.child(button("ask-back", "Back", t, false, (_e, cx) => this.askTab(a.active - 1, cx))))
        .child(last
          ? button("ask-submit", "Submit", t, true, (_e, cx) => this.answerAsk("accept", cx))
          : button("ask-next", "Next", t, true, (_e, cx) => this.askTab(a.active + 1, cx))));
  }

  // One question: its header and text, then options, preview and text boxes.
  askField(q, f, j, t) {
    const a = this.ask;
    const several = q.fields.length > 1;
    const v = a.picks[f.key];
    const on = (o) => (f.kind === "multi" ? (v ?? []).includes(o.value) : v === o.value);
    const choose = (fn) => (_e, cx) => { a.error = null; fn(); this.askFocus.focus(); cx.notify(); };
    const picked = f.options.filter(on);
    const preview = picked.find((o) => o.preview)?.preview;
    const textBox = (key) => div().id(`askx-${j}-${key}`).w_full().rounded(6).border_1().border_color(t.input).bg(t.background).px(8).py(4)
      .child(Textarea.new(a.inputs.get(key)).w_full().text_size(12.5).text_color(t.foreground));
    const question = several ? f.description : !f.options.length && f.kind !== "boolean" ? f.description : null;
    return v_flex().id(`askf-${q.id}-${j}`).gap(6)
      .when(Boolean(f.title) && !several, (el) => el.child(h_flex().child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(f.title + (f.required ? " *" : "")))))
      .when(Boolean(question), (el) => el.child(div().font_medium().child(question + (several && f.required ? " *" : ""))))
      .when(f.kind === "multi", (el) => el.child(div().text_size(11).text_color(t.dim).child("Pick any that apply.")))
      .children(f.options.map((o, k) => h_flex().id(`asko-${j}-${k}`).px(8).py(5).gap(8).rounded(6).items_start().cursor_pointer()
        .when(on(o), (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(choose(() => pick(a.picks, f, o.value)))
        .child(div().w(14).flex_shrink_0().text_color(on(o) ? t.accent : t.dim).child(f.kind === "multi" ? (on(o) ? "☑" : "☐") : on(o) ? "●" : "○"))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_color(on(o) ? t.accent : t.foreground).child(o.label))
          .when(Boolean(o.description), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(o.description))))
        .when(k < 9, (el) => el.child(div().flex_shrink_0().text_size(11).text_color(t.dim).child(String(k + 1))))))
      .when(Boolean(preview), (el) => el.child(div().pl(22).child(md(`askp-${j}`, preview))))
      .when(f.kind === "boolean", (el) => el.child(h_flex().id(`askb-${j}`).px(8).py(5).gap(8).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(choose(() => pick(a.picks, f, null)))
        .child(div().w(14).text_color(v ? t.accent : t.dim).child(v ? "☑" : "☐"))
        .child(div().child(f.description ?? f.title ?? "Yes"))))
      .when(a.inputs.has(f.key), (el) => el.child(textBox(f.key)))
      .when(Boolean(f.other), (el) => el.child(textBox(f.other.key)));
  }

  plan(it, i, t) {
    const mark = { completed: "☑", in_progress: "◐", pending: "☐" };
    return v_flex().id(`pl-${i}`).w_full().p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(12.5)
      .child(div().text_size(11).text_color(t.dim).child("Plan"))
      .children(it.entries.map((e, j) => h_flex().id(`ple-${i}-${j}`).gap(8)
        .child(div().text_color(e.status === "completed" ? t.done : e.status === "in_progress" ? t.working : t.dim).child(mark[e.status] ?? "☐"))
        .child(div().flex_1().min_w(0).text_color(e.status === "completed" ? t.dim : t.foreground).child(e.content))));
  }

  composer(t) {
    const live = this.link?.state === "live" && !this.transcript.exited;
    const pendingPerm = this.transcript.pendingPermission;
    const pendingQ = this.ask ? this.transcript.pendingQuestion : null;
    const slash = this.slashList();
    return v_flex().px(14).pt(8).pb(12).gap(6).border_t_1().border_color(t.border).bg(t.chrome)
      .when(this.attachments.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap().children(this.attachments.map((p, j) =>
        h_flex().id(`att-${j}`).gap(6).px(8).py(2).rounded(6).bg(t.raised).text_size(11.5).items_center()
          .child(div().child(p.split("/").pop()))
          .child(div().id(`attx-${j}`).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.attachments.splice(j, 1); cx.notify(); }).child("✕"))))))
      .when(Boolean(pendingPerm), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child("Claude is waiting for a permission answer above.")))
      .when(Boolean(pendingQ), (el) => el.child(this.askPanel(pendingQ, t)))
      .when(Boolean(slash?.length), (el) => el.child(this.slashPanel(slash, t)))
      .child(h_flex().gap(8).items_end()
        .child(div().id("composer-box")
          // Only while the panel is open, so ↑/↓/Tab/Esc are the textarea's otherwise.
          .when(Boolean(slash?.length), (el) => el.key_context("AcpSlash"))
          .on_action("acp_slash_up", (_e, cx) => this.slashAction("up", cx))
          .on_action("acp_slash_down", (_e, cx) => this.slashAction("down", cx))
          .on_action("acp_slash_complete", (_e, cx) => this.slashAction("complete", cx))
          .on_action("acp_slash_close", (_e, cx) => this.slashAction("close", cx))
          .flex_1().min_w(0).rounded(8).border_1().border_color(t.input).bg(t.background).px(10).py(6)
          .child(Textarea.new(this.input).w_full().text_size(13.5).text_color(t.foreground)))
        .child(this.working
          ? button("stop", "Stop", t, false, () => this.cancel())
          : button("send", "Send", t, true, (_e, cx) => this.submit(cx), !live)));
  }

  // The session's slash commands that fit what is typed, above the composer.
  slashPanel(list, t) {
    const sel = Math.min(this.slashIndex, list.length - 1);
    return v_flex().gap(4)
      .child(v_flex().id("slash").max_h(264).overflow_y_scrollbar().track_scroll(this.slashScroll)
        .p(4).rounded(8).border_1().border_color(t.border).bg(t.popover ?? t.raised).text_size(12.5)
        .children(list.map((c, i) => h_flex().id(`slash-${c.name}`).gap(10).px(8).py(4).rounded(5).items_center().cursor_pointer()
          .when(i === sel, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.chooseSlash(c, false, cx))
          .child(div().flex_shrink_0().text_color(i === sel ? t.accent : t.foreground).child(`/${c.name}`))
          .when(Boolean(c.input?.hint), (el) => el.child(div().flex_shrink_0().max_w(200).truncate().text_color(t.dim).child(c.input.hint)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.description ?? "")))))
      .child(div().px(4).text_size(11).text_color(t.dim).child("↑↓ choose · Tab complete · Enter run · Esc close"));
  }

  maxWidth() {
    return Math.max(160, (this.size?.width ?? 760) - 52);
  }
}

// --- helpers ---------------------------------------------------------------------------

function md(id, text) {
  return TextView.markdown(id, text).selectable(true);
}

// What TextView.html can draw: the body's markup, without comments and the
// elements that only mean something with CSS, scripts or a canvas.
function htmlText(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, "");
  const body = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(s);
  if (body) s = body[1];
  s = s.replace(/<(script|style|head|title|template|noscript|svg|canvas|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|link|meta|base)\b[^>]*>/gi, "")
    // What TextView.html drops or draws unreadably (white on yellow):
    .replace(/<\/?mark\b[^>]*>/gi, "")
    .replace(/<hr\b[^>]*>/gi, "<p>\u2015\u2015\u2015</p>")
    .replace(/<br\b[^>]*>/gi, "</p><p>");
  return s.trim() || "<p><em>Nothing to show without CSS or scripts: use Open.</em></p>";
}

function fenced(text) {
  const s = text.length > MAX_TOOL_TEXT ? text.slice(0, MAX_TOOL_TEXT) + "\n…" : text;
  const ticks = s.includes("```") ? "````" : "```";
  return `${ticks}\n${s.replace(/\n+$/, "")}\n${ticks}`;
}

function toggle(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

function chip(id, text, t, onClick, _tip) {
  return h_flex().id(`chip-${id}`).h(22).px(8).items_center().rounded(5).border_1().border_color(t.border).bg(t.raised)
    .text_size(11.5).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground).bg(t.hover))
    .on_click(onClick).child(text);
}

// A chip's look without a click handler, for a Popover trigger (it owns the press).
function chipFace(id, text, t, active) {
  return h_flex().id(`chip-${id}`).h(22).px(8).items_center().rounded(5).border_1().border_color(t.border).bg(active ? t.hover : t.raised)
    .text_size(11.5).text_color(active ? t.foreground : t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground).bg(t.hover))
    .child(text);
}

function button(id, text, t, primary, onClick, disabled = false) {
  return h_flex().id(`btn-${id}`).h(34).px(14).items_center().rounded(8).text_size(12.5).font_medium()
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
    .border_1().border_color(primary ? t.solid : t.input)
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick))
    .child(text);
}

function mermaidColors(t) {
  const c = (x) => (typeof x === "string" ? x.slice(0, 7) : undefined);
  return { bg: c(t.surface), fg: c(t.foreground), line: c(t.muted), accent: c(t.accent), muted: c(t.dim), surface: c(t.raised), border: c(t.border) };
}

// The hc terminal whose `claude` last recorded this session (hooks/session-start.sh), or null.
async function recordedTerminal(session) {
  const dir = `${home()}/.local/state/herdr-acp-view/terminals`;
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && grep -l -F -- "$2" $(ls -t -- *.json 2>/dev/null) 2>/dev/null | head -n 1', "sh", dir, session]).catch(() => null);
  const name = r?.stdout.trim();
  return name ? name.replace(/\.json$/, "") : null;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtK(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function shortPath(p, cwd) {
  if (p?.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (p?.startsWith(home())) return "~" + p.slice(home().length);
  return p ?? "";
}
