// The bridge's terminal side, when it runs in an hc terminal (link.js starts it
// with `hc run`). This makes the ACP session an hc agent:
//
//   - status:  OSC 7501 reports (working, idle, blocked, error), so hc and the
//              Herdr Agents list see it, and `hc wait` works on it.
//   - input:   what hc types into the terminal (`hc send`, notes from child
//              terminals, a person attached with `hc attach`) becomes a prompt.
//              hc pastes text with bracketed paste, then presses Enter.
//              Esc or Ctrl+C stops the turn (`hc interrupt` presses Esc).
//   - screen:  a plain-text log of the conversation, so `hc read` shows it.
//
// Claude's own tools inherit HC_TERMINAL_ID from this process, so terminals it
// starts with `hc run` are children of this one.

const ESC = "\x1b";
const BEL = "\x07";
const b64 = (s) => Buffer.from(String(s).replace(/[\r\n]+/g, " ").slice(0, 2048)).toString("base64");

export class TerminalSide {
  // onSubmit(text): a finished message. onInterrupt(): Esc or Ctrl+C.
  constructor({ onSubmit, onInterrupt, app = "claude-acp" }) {
    this.onSubmit = onSubmit;
    this.onInterrupt = onInterrupt;
    this.app = app;
    this.out = process.stdout;
    this.draft = "";
    this.paste = false;
    this.esc = null; // an escape sequence in progress
    this.escTimer = null;
    this.last = null; // "agent" while agent text streams, else null
    this.partial = ""; // agent text after its last newline
    this.word = null;
  }

  start() {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => this.feed(d));
    process.stdin.resume();
    this.write(`${ESC}[?2004h`); // bracketed paste: tells pasted text from keys
    return this;
  }

  write(s) {
    try { this.out.write(s); } catch {}
  }

  // --- status ------------------------------------------------------------------

  status(state, { kind, msg } = {}) {
    const key = `${state}|${kind ?? ""}|${msg ?? ""}`;
    if (key === this.word) return;
    this.word = key;
    const f = [`state=${state}`, `app=${this.app}`];
    if (state === "blocked" && kind) f.push(`kind=${kind}`);
    if (msg) f.push(`msg=${b64(msg)}`);
    this.write(`${ESC}]7501;${f.join(":")}${BEL}`);
  }

  title(text) {
    this.write(`${ESC}]2;${String(text).replace(/[\x00-\x1f]/g, " ").slice(0, 120)}${BEL}`);
  }

  // --- input -------------------------------------------------------------------

  feed(d) {
    clearTimeout(this.escTimer);
    for (const ch of d) this.char(ch);
    // A lone Esc (not the start of a key sequence) stops the turn.
    if (this.esc === "") this.escTimer = setTimeout(() => { this.esc = null; if (!this.paste) this.onInterrupt(); }, 60);
    this.redraw();
  }

  char(ch) {
    if (this.esc !== null) return this.sequence(ch);
    if (ch === ESC) { this.esc = ""; return; }
    if (this.paste) { this.draft += ch === "\r" ? "\n" : ch; return; }
    switch (ch) {
      case "\r":
      case "\n": return this.submit();
      case "\x7f":
      case "\b": this.draft = [...this.draft].slice(0, -1).join(""); return;
      case "\x15": this.draft = ""; return; // Ctrl+U
      case "\x03": this.onInterrupt(); return; // Ctrl+C
      default:
        if (ch >= " " || ch === "\t") this.draft += ch;
    }
  }

  // ESC [ params final: bracketed paste markers; other keys (arrows, ...) are ignored.
  sequence(ch) {
    const s = this.esc + ch;
    if (s === "[" || s === "O") { this.esc = s; return; }
    if (s.startsWith("[") && s.length > 1 && /[\x40-\x7e]/.test(ch)) {
      this.esc = null;
      if (s === "[200~") this.paste = true;
      else if (s === "[201~") this.paste = false;
      else if (this.paste) this.draft += ESC + s;
      return;
    }
    if (s.startsWith("[") && s.length < 16) { this.esc = s; return; }
    if (s.startsWith("O") && s.length === 2) { this.esc = null; return; }
    // Alt+key or something unknown: drop the Esc, keep the character.
    this.esc = null;
    if (this.paste) this.draft += ESC + s;
  }

  submit() {
    const text = this.draft.replace(/\s+$/, "");
    this.draft = "";
    if (text) this.onSubmit(text);
  }

  // --- screen --------------------------------------------------------------------

  // The draft's last line under the log, as "› text".
  redraw() {
    const cols = this.out.columns || 100;
    const line = this.draft.split("\n").at(-1);
    const shown = this.draft ? `› ${[...line].slice(-(cols - 3)).join("")}` : "";
    this.write(`\r${ESC}[2K${shown}`);
  }

  // Whole lines above the draft line (the cursor stays at the start of the
  // draft line, so clearing it never erases the log).
  print(text) {
    this.flushAgent();
    this.line(text);
  }

  line(text) {
    this.write(`\r${ESC}[2K${String(text).replace(/\r?\n/g, "\r\n")}\r\n`);
    if (this.draft) this.redraw();
  }

  // Streamed agent text: printed a line at a time.
  agentText(text) {
    if (this.last !== "agent") { this.line(""); this.last = "agent"; this.partial = ""; }
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop();
    for (const p of parts) this.line(p);
  }

  flushAgent() {
    if (this.last !== "agent") return;
    this.last = null;
    if (this.partial) this.line(this.partial);
    this.partial = "";
  }

  // The bridge's events (see bridge.mjs emit) as plain text.
  show(ev) {
    switch (ev.t) {
      case "user":
        this.print(`\n› ${ev.text.replace(/\n/g, "\n  ")}`);
        return;
      case "update": {
        const u = ev.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          this.agentText(u.content.text);
        } else if (u.sessionUpdate === "tool_call") {
          this.print(`  • ${u.title ?? u.kind ?? "tool"}`);
        } else if (u.sessionUpdate === "tool_call_update" && u.status === "failed") {
          this.print(`  ✗ ${u.title ?? "tool"} failed`);
        }
        return;
      }
      case "permission":
        this.print(`  ! Permission needed: ${ev.toolCall?.title ?? "a tool"} (answer it in the rich pane)`);
        return;
      case "permit_done":
        this.print(`  ${ev.optionId ? "✓ answered" : "✗ cancelled"}`);
        return;
      case "turn_end":
        this.print(`— turn ended (${ev.stopReason})`);
        return;
      case "queued":
        this.print(`  (queued: ${ev.count} message${ev.count === 1 ? "" : "s"} for the next turn)`);
        return;
      case "error":
        this.print(`! ${ev.text}`);
        return;
      case "notice":
      case "status":
        this.print(`· ${ev.text}`);
        return;
      case "session":
        this.print(`· session ${ev.sessionId} in ${ev.cwd}`);
        return;
      case "exit":
        this.print(`· Claude exited (${ev.code ?? ev.signal})`);
        return;
    }
  }

  stop() {
    this.write(`${ESC}[?2004l`);
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  }
}
