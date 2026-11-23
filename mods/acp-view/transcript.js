// Folds the bridge's event stream (ACP session/update payloads plus a few
// bridge events) into a list of transcript items the view draws.

export class Transcript {
  constructor() {
    this.reset();
  }

  reset() {
    this.items = [];
    this.tools = new Map();
    this.perms = new Map();
    this.session = null;
    this.mode = null;
    this.config = [];
    this.title = null;
    this.usage = null;
    this.cost = null;
    this.status = null;
    this.commands = [];
    this.plan = null;
    this.exited = false;
  }

  // A select config option by category ("model", "thought_level"), with its
  // choices flattened (ACP lets an agent group them).
  option(category) {
    const o = this.config.find((c) => c.category === category && c.type === "select");
    if (!o) return null;
    const choices = (o.options ?? []).flatMap((x) => (Array.isArray(x.options) ? x.options : [x]));
    return { ...o, choices, current: choices.find((c) => c.value === o.currentValue) ?? null };
  }

  get pendingPermission() {
    for (const p of this.perms.values()) if (p.answer === undefined) return p;
    return null;
  }

  apply(ev) {
    switch (ev.t) {
      case "status": this.status = ev.text; break;
      case "session":
        this.session = ev;
        this.mode = ev.modes?.currentModeId ?? this.mode;
        this.config = ev.configOptions ?? [];
        this.status = null;
        break;
      case "user": this.items.push({ kind: "user", text: ev.text ?? "", images: ev.images ?? [] }); break;
      case "update": this.update(ev.update); break;
      case "usage":
        this.usage = ev.update;
        if (ev.update?.cost) this.cost = ev.update.cost;
        break;
      case "permission": {
        const item = { kind: "permission", id: ev.id, toolCall: ev.toolCall ?? {}, options: ev.options ?? [], answer: undefined };
        this.perms.set(ev.id, item);
        this.items.push(item);
        break;
      }
      case "permit_done": {
        const p = this.perms.get(ev.id);
        if (p) p.answer = ev.optionId;
        break;
      }
      case "turn_end":
        if (ev.stopReason && ev.stopReason !== "end_turn") this.items.push({ kind: "notice", text: stopText(ev.stopReason) });
        break;
      case "notice": this.items.push({ kind: "notice", text: ev.text }); break;
      case "error": this.items.push({ kind: "error", text: ev.text }); break;
      case "exit":
        this.exited = true;
        this.items.push({ kind: "error", text: "Claude exited." });
        break;
    }
  }

  update(u) {
    switch (u?.sessionUpdate) {
      case "user_message_chunk": return this.chunk("user", u);
      case "agent_message_chunk": return this.chunk("agent", u);
      case "agent_thought_chunk": return this.chunk("thought", u);
      case "tool_call":
      case "tool_call_update": {
        let item = this.tools.get(u.toolCallId);
        if (!item) {
          item = { kind: "tool", toolCallId: u.toolCallId, title: "", status: "pending", content: [] };
          this.tools.set(u.toolCallId, item);
          this.items.push(item);
        }
        // ACP's tool `kind` (execute, edit, …) would clobber the item's own kind.
        for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== null && k !== "sessionUpdate") item[k === "kind" ? "toolKind" : k] = v;
        return;
      }
      case "plan":
        if (this.plan) this.plan.entries = u.entries ?? [];
        else {
          this.plan = { kind: "plan", entries: u.entries ?? [] };
          this.items.push(this.plan);
        }
        return;
      case "current_mode_update": this.mode = u.currentModeId; return;
      case "config_option_update": if (Array.isArray(u.configOptions)) this.config = u.configOptions; return;
      case "session_info_update": if (u.title) this.title = u.title; return;
      case "available_commands_update": this.commands = u.availableCommands ?? []; return;
    }
  }

  chunk(kind, u) {
    const c = u.content ?? {};
    const id = u.messageId ?? null;
    let last = this.items.at(-1);
    if (!last || last.kind !== kind || (last.messageId ?? null) !== id) {
      last = { kind, messageId: id, text: "", images: [] };
      this.items.push(last);
    }
    if (c.type === "text") last.text += c.text ?? "";
    else if (c.type === "image" && c.path) last.images.push(c);
    else if (c.type === "resource_link") last.text += `[${c.title ?? c.name ?? c.uri}](${c.uri})`;
    else if (c.type === "resource" && c.resource?.text) last.text += `\n\`\`\`\n${c.resource.text}\n\`\`\`\n`;
  }
}

function stopText(reason) {
  return {
    cancelled: "Stopped.",
    max_tokens: "Stopped: the reply hit the token limit.",
    max_turn_requests: "Stopped: too many steps in one turn.",
    refusal: "Claude declined to continue.",
  }[reason] ?? `Stopped (${reason}).`;
}
