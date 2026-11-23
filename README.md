# herdr-factory

A Herdr layout for running Claude Code agents, including ACP sessions that
coordinate sub-agents with `hc`. It is Herdr's `main` layout plus:

- **Claude (ACP)** in the tab bar's + menu: a new tab holding only the rich
  ACP pane (`acp-view`). Its bridge runs in an hc terminal with no pane, so the
  session has an hc address (`hc run` sub-agents, `hc wait --children`, notes)
  without a terminal pane next to it.
- An agents list that shows those detached ACP sessions under their tab, with
  their sub-agents nested.

## Contents

| Path | What it is |
|---|---|
| `layouts/herdr-factory.json` | The window: sidebar (spaces, agents), tab bar, panes, Files/Changes panel, status bar |
| `layouts/herdr-factory.svg` | Its preview in Herdr's settings |
| `mods/factory-tabs/` | Clone of Herdr's `tabs`: + opens `factory-new-menu` |
| `mods/factory-new-menu/` | Clone of `new-menu`: adds **Claude (ACP)**; taller New worktree dialog |
| `mods/factory-agents/` | Clone of `agents`: lists detached ACP bridges (`acp-view.tab` label) |
| `mods/acp-view/` | Claude Code over ACP, drawn natively; see its README |

The three `factory-*` mods are clones of Herdr 0.1.16's shipped mods
(`cloned_from` in each `mod.json`). Herdr never updates clones: after a Herdr
update, compare them with `~/.config/herdr-app/mods/<name>/`.

## Install

```sh
./install.sh
```

It links each layout file and mod folder into `~/.config/herdr-app`
(`HERDR_APP_HOME` picks another), so Herdr runs the files in this repo.

Herdr reloads a mod or layout when it sees a change in its own folder, and a
change inside a symlinked folder doesn't reach it. While editing, keep this
running; it touches the link whenever a file under it changes:

```sh
./watch.sh        # needs inotify-tools
```

Without it, new panes and tabs load the new code but open ones don't;
`touch -h ~/.config/herdr-app/mods/<name>` reloads one by hand.

`acp-view` also needs:

- Node.js; the bridge runs `npm install` in `mods/acp-view/bridge` on its first start.
- Its Claude Code `SessionStart` hook in `~/.claude/settings.json`, which marks
  sessions that are open in a terminal:

  ```json
  { "type": "command", "command": "~/.config/herdr-app/mods/acp-view/hooks/session-start.sh" }
  ```

## Known gaps

- `acp-view` draws ```` ```html ```` blocks with Herdr's native HTML text:
  headings, paragraphs, links, tables, lists, quotes and inline code, no CSS or
  scripts (**Open** shows the real page in the browser). Bold and italic don't
  show, in HTML or Markdown alike.

- Herdr's own agent count, tab and space status dots, and agent sounds don't
  see detached ACP sessions (`acp-view` shows its own notifications).
- `ctrl-shift-a` ACP panes still start a bridge with a terminal pane, as in
  Herdr's `main` layout.
