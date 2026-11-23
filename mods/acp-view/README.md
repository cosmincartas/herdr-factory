# acp-view — Claude Code as rich text, in a pane of its own

An ACP pane runs Claude Code through the Agent Client Protocol (ACP) and draws
it natively. It isn't tied to a terminal: each pane owns one session in its
folder, a new one or any earlier Claude Code session there.

```
acp-view pane (GPUI mod) ──WebSocket (127.0.0.1, token)──▶ bridge/bridge.mjs ──stdio ACP──▶ claude-agent-acp ──▶ Claude
```

## Use it

`ctrl-shift-a` (`"ctrl-shift-a": "mod.open:acp-view"` in `keys.json`, `global`) splits
the focused pane to the right with a new ACP pane, in that pane's folder (a mod
pane has none: then a terminal's in the same tab, then the space's folder).
It's an ordinary Herdr pane: zoom, move, close and split it like any other, and
it is saved with its tab.

In the pane's header:

- **+ New** ends the pane's session and starts a new one in the same folder.
- **Sessions** lists the earlier Claude Code sessions in the folder, newest
  first (from `~/.claude/projects`), and resumes the one you pick with
  `session/load`: same session id, same transcript file, so `claude --resume <id>`
  in a terminal picks up the turns taken here.

A session that is also open in a live Claude terminal is marked `open in tN` in
the list, and the pane shows a warning while it runs it. Both sides write the
same transcript, so take turns in only one of them, or the conversation splits.
That check uses `hooks/session-start.sh`, a Claude Code `SessionStart` hook
(registered in `~/.claude/settings.json`) that records which session each hc
terminal runs in `~/.local/state/herdr-acp-view/terminals/<HC_TERMINAL_ID>.json`.

## An hc agent: coordinating subagents

The bridge runs in an hc terminal (say `t5m`) with a pane in the ACP pane's tab.
That terminal is the session's hc address; the header shows it as a chip (click
it to focus that terminal). So the session works like a Claude terminal for hc:

- It is in the Agents sidebar, with status from OSC 7501 reports
  (`app=claude-acp`): `working` during a turn, `blocked` (kind `permission`,
  the tool's title as message) while a permission prompt is open, `idle` after
  a turn, `error` when a turn fails. Herdr plays the sounds and notifications.
- Claude's tools inherit `HC_TERMINAL_ID`, so `hc run` from Claude starts
  sub-agents of this terminal, `hc wait --children` works, and the `shepherd`
  skill passes its preflight.
- Text typed into the terminal is a prompt: `hc send t5m "..."`, reports and
  notes from sub-agents, or a person after `hc attach t5m`. Text that arrives
  during a turn (or a permission prompt) waits, and goes as the next turn,
  joined. The pane shows these turns like its own.
- `hc interrupt t5m` (Esc) or Ctrl+C in the terminal stops the turn.
- The terminal shows a plain-text log of the conversation, so `hc read t5m`
  works. Permission prompts are answered in the pane only.

## What it shows

- Markdown via `TextView.markdown` (headings, tables, lists, code, links), selectable.
- ```` ```mermaid ```` blocks → rendered by the bridge with beautiful-mermaid in the
  current theme's colors, flattened (CSS vars / color-mix → literals) and rasterized
  by resvg to PNG. Unsupported diagram types fall back to source + error.
- ```` ```html ```` blocks → drawn as native HTML text (`TextView.html`): headings,
  paragraphs, links, tables, lists, quotes, inline code. No CSS or scripts:
  `<style>`, `<script>`, `<svg>`, `<canvas>` and the like are left out; `<mark>`
  is unwrapped, `<hr>` and `<br>` become a rule and a break. **Source** shows the
  code, **Open** writes the page to `acp-view-assets/` and opens it in the browser.
  Bold and italic don't show (in Markdown either). While the block is being
  written it shows as code.
- `![alt](src)` images — absolute, `~`, relative to the session folder, `file://`,
  `http(s)://` or `data:` — and ACP image blocks (e.g. Claude reading a PNG).
  Click a picture to open it with `xdg-open`.
- Tool calls as collapsible cards (diffs open by default, as unified patches),
  thoughts (collapsed), plans, permission requests as buttons, usage and cost.
- Mode chip (click cycles Manual → Accept edits → Plan → Auto → Bypass), Stop.
- **Model** and **Effort** chips: click one for a menu of what the session
  offers (ACP `configOptions`, set with `session/set_config_option`). A model
  switch can change the effort levels on offer; the chips show what the agent
  reports back. The pane remembers its picks (`config` in its store) and sends
  them again to each new session it starts: + New, a resumed session, or a
  restarted bridge. A pick the new session doesn't offer is skipped.
- Drop PNG/JPEG/GIF/WebP files on the pane to attach them to the next message.

## The bridge and its lifetime

An hc terminal started by the pane (`hc run --bg --no-parent`, labels
`acp-view=<id>`, `herdr.space`, `herdr.tab`), with diagnostics in its log file.
A pane with no tab id gets a terminal without the Herdr labels: it has an hc
address but no pane, so it isn't in the Agents sidebar.

- The pane keeps its folder, session id and bridge info in its own
  `localStorage` (each pane gets a unique `id` prop), so a mod reload or an app
  restart reconnects and replays.
- A hidden tab keeps its pane and bridge running.
- Closing the pane ends the bridge 20 s later, unless a view reconnects; a turn
  or a permission prompt still running is let finish first.
- A mod reload stops the old view without closing its WebSocket. Each pane
  sends a view id kept in its store (`view-id`), and the bridge drops an older
  connection with the same id, so a reload's leftover socket doesn't count as
  a view (before, the bridge then never ended after the pane closed). The
  bridge log records each view connecting and disconnecting.
- If the bridge is gone (closed, crashed, app restarted), the pane starts a new
  one and resumes its session with `session/load`.
- A bridge with no view for 30 minutes exits, but never during a turn, with a
  permission prompt open, with queued messages, or with live sub-agents (hc
  ends a terminal's children with it). Closing the pane also waits while
  sub-agents run, so an app quit doesn't end them.
- Closing the bridge's terminal pane ends the bridge (and its sub-agents); the
  ACP pane then starts a new one and resumes the session.
- `+ New` and resuming another session end the bridge, so its sub-agents end too.

Files: bridge info (`pid`, `port`, `token`) and logs in `~/.local/state/herdr-acp-view/`,
pictures in `~/.config/herdr-app/mods/acp-view-assets/` (content-named, safe to delete).
`bridge/sessions.mjs CWD` prints the session list the picker shows.

## Limits

- Local only: the bridge and transcripts are on this computer. The key refuses
  a focused pane on another machine.
- Nothing locks a terminal running the same session (see the warning above).
- Herdr places the bridge's terminal pane in the tab itself; the mod doesn't
  choose where. Adoption turns on core keep, so a bridge killed by a signal
  leaves a shell in that pane.
- Bridges started before this change are detached: they keep working, without
  an hc address. To move a pane to an hc terminal and keep its session, stop
  its old bridge between turns (`kill <pid>` from its info file in
  `~/.local/state/herdr-acp-view/`): the pane starts a new bridge and resumes
  the session. `+ New` also works, with a new session.
- Code blocks are not syntax-highlighted (TextView limitation).
- `fs/*` and `terminal/*` client capabilities are off; Claude uses its own tools.
- In the + menu only in the `herdr-factory` layout: its `factory-tabs` opens
  `factory-new-menu` (clones of the shipped mods), whose **Claude (ACP)** opens a
  new tab with `tab.new {mod: "acp-view", props: {id, cwd, adoptTab: true}}`.
  A mod pane isn't told its tab, so that pane takes a tab whose only pane is an
  ACP pane and that no other ACP pane has claimed (`shared("acp-view.tabs")`),
  preferring the focused one, keeps it in its store, and only then starts the
  bridge. That bridge is **detached**: its hc terminal gets `acp-view.space` /
  `acp-view.tab` labels instead of `herdr.space` / `herdr.tab`, so Herdr gives
  it no pane and the tab holds only the ACP pane. Herdr's own agents list,
  tab status dots and agent count don't see it; the layout's `factory-agents`
  (a clone of `agents`) lists it under its tab from `terminals()`, with its
  sub-agents nested, and a click focuses the ACP pane (or peeks at the
  bridge when the pane is gone). The header's hc chip peeks at it too. The folder is the focused pane's, else a
  terminal's in that tab or space (space folders can be stale).
- Pinned: `@agentclientprotocol/claude-agent-acp@0.107.3`. Update in `bridge/package.json`, then `npm install` there.
