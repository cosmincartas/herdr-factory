# herdr-explorer

A keyboard-driven file explorer pane for [Herdr](https://herdr.dev) that opens files in a
Helix pane next to it. It works with upstream Helix (25.07+) and evil-helix; no editor plugin needed.

- The tree is rooted at the git checkout (else the folder) of the terminal you last focused,
  and remembers each project's open folders.
- Files open in a Helix pane **in the current tab**, never one in another tab: the tab's
  paired Helix (the one you last opened into or revealed from there), else the last focused
  Helix in the tab, else any Helix in the tab. With none in the tab, a new `hx` pane opens
  to the right.
- Git status marks (`M` `A` `D` `U`), a dot on folders with changes, live updates through
  a folder watch (local) or a 10 s refresh (remote spaces).
- Laid out like Orca's Files pane: a toolbar (folder name, Collapse All, Refresh, and a `…` menu
  with Show Dotfiles), a **Names | Contents** switch, then the tree. Hover the folder name to see
  which Helix pane files open in.
- **Find files** (`/`, Names): fuzzy match on file names over the whole checkout, like Orca's; the
  matches show as a tree of their folders (`h`/`l` fold them). It uses
  `rg --files` (`.gitignore` respected, hidden files included, `.git` left out), falling back to `find`.
- **Search** (`?`, Contents): file contents through ripgrep, like Orca's search. Results are grouped by file
  and open in Helix at the matching line and column. It has match case, whole word, regex,
  files to include and files to exclude (comma-separated globs), and stops at 2,000 matches.
- Drag a row onto a terminal to paste its path.

## How it reaches Helix

Helix has no remote-control API, and Herdr can't type `:` into it (Helix asks the terminal
for detailed key reports, so Shift+; arrives as Shift+;). So the explorer writes the path
to `$XDG_RUNTIME_DIR/herdr-explorer/<terminal id>` and presses `Esc`, `F12` in that
terminal. Helix binds F12 to `:open %sh{herdr-explorer take}`, which prints the queued
path and deletes it. Esc first means it works from insert mode and with a picker open.

The other way, `herdr-explorer reveal <file>` (bound to `space e` below) writes a reveal request.
The explorer expands to that file, selects it, takes the keyboard, and pairs with that Helix.

## Install

herdr-factory's `install.sh` (at the repo root) links this folder to
`~/.config/herdr-app/mods/herdr-explorer` and `bin/herdr-explorer` to `~/.local/bin`
(Helix must find it on `PATH`).

`mod.json` has `"place": "none"`, so Herdr doesn't dock it anywhere by itself. The
`herdr-factory` layout puts it in the side panel's Files slot, in place of Herdr's `files` mod:
the `files` block under `panel-body` has `"content": { "mod": "herdr-explorer" }`. Keep the
id `files`, so the tab bar's **Files** button still opens it.

Herdr doesn't see edits inside a symlinked folder: keep the repo's `watch.sh` running, or run
`touch -h ~/.config/herdr-app/mods/herdr-explorer` after a change.

Then add to `~/.config/helix/config.toml`:

```toml
[keys.normal]
# herdr-explorer presses this to open a file; keep it.
F12 = ":open %sh{herdr-explorer take}"

[keys.normal.space]
# Show the current file in the explorer.
e = ":sh herdr-explorer reveal %{buffer_name}"

# Optional: open straight from insert and select mode too. Without these, the
# explorer notices F12 did nothing and presses Esc, F12 (~250 ms slower).
[keys.insert]
F12 = ["normal_mode", ":open %sh{herdr-explorer take}"]

[keys.select]
F12 = ["normal_mode", ":open %sh{herdr-explorer take}"]
```

And a Herdr key to jump to the explorer and back, in `~/.config/herdr-app/keys.json`:

```json
{ "global": { "alt-e": "herdr-explorer.toggle-focus" },
  "terminal": { "alt-e": "herdr-explorer.toggle-focus" } }
```

If a file doesn't open, the explorer says so after 5 s; that means the F12 binding is missing.

To open the panel on Find files or Search from anywhere (a terminal, or a Helix key such as
`":sh herdr-explorer search %{selection}"`):

```sh
herdr-explorer find [TEXT]     # shows herdr-factory's side panel, starts Find files
herdr-explorer search [TEXT]   # same, on Search
```

Herdr keys can start them too, while the panel is shown (`keys.json` actions only reach shown mods):
`"herdr-explorer.find-files"`, `"herdr-explorer.search"`.

## Ctrl+click a path in a terminal

`link.js` takes Herdr's Ctrl+clicks on file paths in terminals (compiler errors, `rg` output, an
agent's `src/foo.rs:42:7`) and opens them in that tab's Helix the same way the explorer does, at
the line and column when the path has them. With no Helix in the tab, a new `hx` pane opens beside
the clicked terminal. Folders, pictures, PDFs, media, archives and binaries, and remote paths, go
to Herdr's usual opener. `mod.json` declares the link rule; Herdr then adds
`"link_handlers": ["herdr-explorer"]` to the layout's root (remove it there to turn this off).

The Helix picked (paired, else last focused, else any in the tab) is kept in the mod's
`localStorage`, so clicks and the explorer agree on it.

## Keys (explorer focused)

| Key | Action |
|---|---|
| `j` `k` / arrows | Move |
| `l` / `→` | Expand folder, or open file in Helix and focus it |
| `h` / `←` | Collapse folder, or go to its parent |
| `enter` | Toggle folder, or open file in Helix and focus it |
| `o` | Open file in Helix, keep the explorer focused |
| `gg` / `ge` (also `G`), `ctrl-d` / `ctrl-u` | Top / end, half page |
| `gw` | Jump: label the rows on screen, type a label to move there (like Helix's `gw`) |
| `.` | Show or hide dotfiles |
| `r` | Refresh |
| `/` | Find files |
| `?` | Search file contents |
| `esc` / `q` | Back to the paired Helix |

In Find files and Search, letters type into the box and these keys work while typing:

| Key | Action |
|---|---|
| `↑` `↓`, `ctrl-p` `ctrl-n` | Choose a result |
| `enter` | Open in Helix and focus it (on a Search file row: fold it) |
| `shift-enter` | Open in Helix, keep the explorer focused |
| `alt-c` / `alt-w` / `alt-r` | Search: match case / whole word / regex |
| `esc` | Find files: clear it. Search: back to the tree |

With the keyboard on a results list (not the box), `j` `k`, `gg` / `ge` and `enter` / `l` / `o` work as in the tree,
and `gw` labels the Find files rows (not Search results, whose rows vary in height).

## Settings

At the top of `router.js`:

- `EDITORS`: program keys treated as Helix (Herdr names Helix panes `hx`; evil-helix's binary is also `hx`).
- `OPEN_KEY`: the key pressed to open (`f12`). Change it here and in Helix if F12 is taken.
- `FALLBACK_AFTER`: `hc keys` takes ~32 ms per key, so the key goes alone first; if Helix hasn't
  taken the file after this many ms (a picker or prompt is open), `esc` and the key follow.
- `EDITOR_ARGV`: what a new editor pane runs.

## Limits

- Remote spaces are untested. A Helix on another machine needs `herdr-explorer` on that
  machine's `PATH` to receive files, and can't reveal (Herdr's folder watch is local only).
- Up to 500 entries per folder and 5,000 rows.
- Find files lists up to 50,000 files and shows the best 200 matches.
- No file operations (create, rename, delete) or replace yet.
