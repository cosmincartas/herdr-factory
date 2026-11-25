// The "Port forwards" dialog (UI-1): choose an SSH machine, add a forward and
// stop one. All behavior lives in forward.js; this view only builds its Deps,
// holds the form and shows the result.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { checking, exec, hc, notify, spaces, theme } from "herdr";
import {
  ensureForward,
  listForwards,
  parseForwardForm,
  sshMachines,
  stopForward,
} from "./forward.js";

/** @typedef {import("./forward.js").Deps} Deps */

/**
 * The effects forward.js performs, from herdr and the system (spec Deps).
 * @type {Deps}
 */
const deps = {
  hc: (args) => hc(args),
  exec: (command, args, options) => exec(command, args, options),
  notify: (n) => notify(n),
  // A view may use its cx timer; the core takes Deps, so it sleeps as a process.
  sleep: async (ms) => {
    await exec("sleep", [String(ms / 1000)]);
  },
  now: () => Date.now(),
};

export default class PortForwards extends View {
  init(_props, cx) {
    this.machines = null; // null while `hc machine ls` runs
    this.forwards = null; // null while `hc ls` runs
    this.loading = true;
    this.error = "";
    this.machine = null;
    this.adding = false;
    this.stopping = new Set();
    this.forwardsSeq = 0; // only the newest list refresh may publish
    this.remoteFocused = false;
    this.localFocused = false;
    this.localPlaceholder = "5432";

    this.handle = cx.focus_handle();
    this.handle.focus();

    this.remote = InputState.new({ placeholder: "5432" });
    this.remote.on("change", (_e, cx) => {
      this.error = "";
      this.syncLocalPlaceholder();
      cx.notify();
    });
    this.remote.on("submit", (_e, cx) => this.add(cx));
    this.remote.on("focus", (_e, cx) => { this.remoteFocused = true; cx.notify(); });
    this.remote.on("blur", (_e, cx) => { this.remoteFocused = false; cx.notify(); });

    this.local = this.newLocal("5432");
    this.remote.focus();

    // A check loads and renders the view but must not run helpers (AGENTS.md).
    if (checking()) return;

    // The input mounts after init: focus it again once it is on screen.
    cx.timer.after(100, () => this.remote.focus());

    cx.spawn(async (cx) => {
      const [machines, forwards] = await Promise.all([
        sshMachines(deps).then((v) => ({ v })).catch((e) => ({ e })),
        listForwards(deps).then((v) => ({ v })).catch((e) => ({ e })),
      ]);
      this.machines = machines.v ?? [];
      this.forwards = forwards.v ?? [];
      if (machines.e) this.error = messageOf(machines.e);
      else this.selectInitialMachine();
      if (forwards.e && !this.error) this.error = messageOf(forwards.e);
      this.loading = false;
      cx.notify();
    });
  }

  /** The local port field, its placeholder showing the remote port as it is typed. */
  newLocal(placeholder) {
    const state = InputState.new({ value: this.local?.value() ?? "", placeholder });
    state.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    state.on("submit", (_e, cx) => this.add(cx));
    state.on("focus", (_e, cx) => { this.localFocused = true; cx.notify(); });
    state.on("blur", (_e, cx) => { this.localFocused = false; cx.notify(); });
    return state;
  }

  syncLocalPlaceholder() {
    const placeholder = this.remote.value().trim() || "5432";
    if (placeholder === this.localPlaceholder) return;
    this.localPlaceholder = placeholder;
    const previous = this.local;
    this.local = this.newLocal(placeholder);
    previous.release();
    if (this.localFocused) this.local.focus();
  }

  /** UI-1: the shown space's SSH machine, else the first one. */
  selectInitialMachine() {
    const active = spaces().find((space) => space.active)?.machine ?? null;
    const names = (this.machines ?? []).map((machine) => machine.name);
    this.machine = active && names.includes(active) ? active : (names[0] ?? null);
  }

  add(cx) {
    if (this.loading || this.adding || !(this.machines ?? []).length) return;
    this.error = "";
    const parsed = parseForwardForm({
      machine: this.machine ?? "",
      remotePort: this.remote.value(),
      localPort: this.local.value(),
    });
    if (!parsed.ok) {
      this.error = parsed.error;
      cx.notify();
      return;
    }

    this.adding = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await ensureForward(parsed.request, deps);
        if (!result.ok) this.error = result.reason;
      } catch (e) {
        this.error = messageOf(e);
      }
      await this.refreshForwards();
      this.adding = false;
      cx.notify();
    });
  }

  stop(forward, cx) {
    if (this.stopping.has(forward.address)) return;
    this.error = "";
    this.stopping.add(forward.address);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await stopForward(forward.address, deps);
        if (!result.ok) this.error = result.reason;
      } catch (e) {
        this.error = messageOf(e);
      }
      await this.refreshForwards();
      this.stopping.delete(forward.address);
      cx.notify();
    });
  }

  async refreshForwards() {
    const seq = ++this.forwardsSeq;
    try {
      const forwards = await listForwards(deps);
      if (seq === this.forwardsSeq) this.forwards = forwards;
    } catch (e) {
      if (seq === this.forwardsSeq && !this.error) this.error = messageOf(e);
    }
  }

  chip(machine, t) {
    const selected = machine.name === this.machine;
    return div()
      .id(`pf-machine-${machine.name}`)
      .px(10)
      .py(4)
      .rounded(6)
      .text_size(12.5)
      .when(selected, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!selected, (el) => el.bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover)))
      .cursor_pointer()
      .on_click((_e, cx) => {
        this.machine = machine.name;
        this.error = "";
        cx.notify();
      })
      .child(machine.name);
  }

  field(t, label, input, focused) {
    return h_flex()
      .gap(6)
      .items_center()
      .child(div().flex_none().text_size(12).text_color(t.muted).child(label))
      .child(
        Input.new(input)
          .w(92)
          .h(30)
          .px(8)
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(focused ? t.accent : t.input)
          .bg(t.background)
          .text_color(t.foreground),
      );
  }

  form(t, cx) {
    const disabled = this.loading || this.adding || !(this.machines ?? []).length;
    return h_flex()
      .gap(12)
      .items_center()
      .child(this.field(t, "Remote port", this.remote, this.remoteFocused))
      .child(this.field(t, "Local port", this.local, this.localFocused))
      .child(div().flex_1())
      .child(
        div()
          .id("pf-add")
          .h(30)
          .px(14)
          .flex()
          .items_center()
          .rounded(6)
          .bg(t.solid)
          .text_color(t.solid_foreground)
          .text_size(12.5)
          .font_medium()
          .when(disabled, (el) => el.opacity(0.4))
          .when(!disabled, (el) =>
            el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.add(cx)),
          )
          .child(this.adding ? "Adding…" : "Add"),
      );
  }

  row(t, forward, cx) {
    const stopping = this.stopping.has(forward.address);
    return h_flex()
      .id(`pf-${forward.address}`)
      .flex_none()
      .h(32)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .hover((s) => s.bg(t.hover))
      .child(div().flex_none().w(90).truncate().text_color(t.foreground).child(forward.machine))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(t.muted)
          .child(`localhost:${forward.localPort} \u2192 ${forward.remoteHost}:${forward.remotePort}`),
      )
      .child(
        div()
          .id(`pf-stop-${forward.address}`)
          .flex_none()
          .h(24)
          .px(10)
          .flex()
          .items_center()
          .rounded(6)
          .border(1)
          .border_color(t.input)
          .bg(t.raised)
          .text_size(12)
          .text_color(t.foreground)
          .when(stopping, (el) => el.opacity(0.5))
          .when(!stopping, (el) =>
            el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.stop(forward, cx)),
          )
          .child(stopping ? "Stopping…" : "Stop"),
      );
  }

  list(t, cx, loaded, forwards) {
    if (!loaded) {
      return v_flex().flex_1().min_h(0).child(div().text_color(t.muted).child("Loading…"));
    }
    if (forwards.length === 0) {
      return v_flex().flex_1().min_h(0).child(div().text_color(t.muted).child("No port forwards"));
    }
    return v_flex()
      .id("pf-list")
      .flex_1()
      .min_h(0)
      .gap(2)
      .overflow_y_scrollbar()
      .children(forwards.map((forward) => this.row(t, forward, cx)));
  }

  render(cx) {
    const t = theme();
    const machines = this.machines ?? [];
    const loaded = !this.loading;
    const noMachines = loaded && machines.length === 0;
    return v_flex()
      .id("port-forward")
      .track_focus(this.handle)
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(div().font_semibold().child("Port forwards"))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_none().w(64).text_color(t.muted).child("Machine"))
          .when(this.loading, (el) => el.child(div().text_color(t.muted).child("Loading…")))
          .when(noMachines, (el) =>
            el.child(div().text_color(t.muted).child("No SSH machines. Add one with hc machine add.")),
          )
          .when(loaded && !noMachines, (el) => el.children(machines.map((machine) => this.chip(machine, t)))),
      )
      .child(this.form(t, cx))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().h(1).flex_none().bg(t.border))
      .child(this.list(t, cx, loaded, this.forwards ?? []));
  }
}

const messageOf = (e) => String(e?.message ?? e ?? "failed");
