# herdr-factory

My Herdr setup: a layout for running Claude Code agents, including ACP sessions
that coordinate sub-agents with `hc`, and the mods it uses. The layout is
Herdr's `main` layout plus:

- **Claude (ACP)** in the tab bar's + menu: a new tab holding only the rich
  ACP pane (`acp-view`). Its bridge runs in an hc terminal with no pane, so the
  session has an hc address (`hc run` sub-agents, `hc wait --children`, notes)
  without a terminal pane next to it.
- An agents list that shows those detached ACP sessions under their tab, with
  their sub-agents nested.
- A keyboard-driven file explorer in the side panel's Files slot that opens
  files in Helix (`herdr-explorer`), and Ctrl+click on terminal paths into Helix.
- Ctrl+click on a `localhost` URL with a port in a terminal on an SSH machine
  forwards that port to this computer and opens the page in the browser
  (`port-forward`). The **Port forwards** command-palette entry (search
  "ssh tunnel ports") opens a dialog that adds, lists and stops forwards.
- A start-point picker in the New worktree dialog (`factory-worktree`).
- A tmux-style `Ctrl+B` prefix (`herdr-tui-prefix`).

## Contents

| Path | What it is |
|---|---|
| `layouts/herdr-factory.json` | The window: sidebar (spaces, agents), tab bar, panes, Files/Changes panel, status bar |
| `layouts/herdr-factory.svg` | Its preview in Herdr's settings |
| `mods/factory-tabs/` | Clone of Herdr's `tabs`: + opens `factory-new-menu` |
| `mods/factory-new-menu/` | Clone of `new-menu`: adds **Claude (ACP)**; New and Open worktree open `factory-worktree` |
| `mods/factory-worktree/` | Clone of `worktree`: New worktree picks the branch it starts from; see its README |
| `mods/factory-agents/` | Clone of `agents`: lists detached ACP bridges (`acp-view.tab` label) |
| `mods/acp-view/` | Claude Code over ACP, drawn natively; see its README |
| `mods/herdr-explorer/` | File explorer and Ctrl+click handler that open files in Helix; see its README |
| `mods/herdr-tui-prefix/` | `Ctrl+B` prefix popup, tmux-style; see its README |
| `mods/port-forward/` | Ctrl+click forwards a remote `localhost` port and opens the page; **Port forwards** dialog adds, lists and stops forwards |

The `factory-*` mods are clones of Herdr's shipped mods (`cloned_from` in
each `mod.json` gives the version). Herdr never updates clones: after a Herdr
update, compare them with `~/.config/herdr-app/mods/<name>/`.

## Install

```sh
./install.sh
```

It links each layout file and mod folder into `~/.config/herdr-app`
(`HERDR_APP_HOME` picks another), so Herdr runs the files in this repo, and
`herdr-explorer`'s Helix helper into `~/.local/bin`. Anything it replaces
that isn't a link is moved to `~/.config/herdr-app/.pre-herdr-factory/<time>/`.

Herdr reloads a mod or layout when it sees a change in its own folder, and a
change inside a symlinked folder doesn't reach it. While editing, keep this
running; it touches the link whenever a file under it changes:

```sh
./watch.sh        # needs inotify-tools
```

Without it, new panes and tabs load the new code but open ones don't;
`touch -h ~/.config/herdr-app/mods/<name>` reloads one by hand.

Some mods also need setup outside this repo:

- `herdr-explorer`: Helix keys in `~/.config/helix/config.toml` (F12 to open,
  `space e` to reveal) and optionally `alt-e` in `keys.json`; see its README.
- `herdr-tui-prefix`: the `ctrl-b` bindings in `~/.config/herdr-app/keys.json`;
  see its README.
- `port-forward`: an SSH machine from `hc machine ls` with key or agent
  authentication and a known host key, plus Linux `ss` and `xdg-open`.

`acp-view` needs:

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
- New worktree from a space's right-click menu (Herdr's `menu` mod, opened by
  `spaces`) still opens Herdr's `worktree`, without the start-point picker. Only
  the tab bar's + menu opens `factory-worktree`.

- `port-forward` forwards only when you Ctrl+click a loopback URL or add one in
  the dialog; it doesn't watch terminals or remote machines for new ports or
  URLs.
- Machines added with `--via` (no SSH target) can't be forwarded; only SSH
  machines can.
- A forward outlives the Herdr window: it stops from the dialog or when its
  `ssh` exits, whichever comes first.
- A forward whose `ssh` exits, for example after a network drop, is not
  restarted; the next Ctrl+click or dialog add starts a new one.
