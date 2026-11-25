# factory-worktree

Clone of Herdr's `worktree` mod (`cloned_from` in `mod.json`) whose New worktree
dialog picks the branch the new worktree starts from. Stock Herdr always branches
from `HEAD`.

- A filterable, scrollable list of `HEAD` plus every local and remote branch, most
  recently committed first.
- `↑`/`↓` to move (the selection stays in view), `tab` to jump between the branch
  name and the filter, mouse wheel to scroll.
- A fixed-width position counter (`12/100`, or `3/12 of 100` while filtering), so
  nothing shifts as you move.
- Typing the name of an existing local branch checks that branch out instead (no
  start point needed).
- A branch started from a remote (`origin/x`) gets `--no-track`, so it doesn't
  push to that remote by accident.
- The dialog's path preview shows where the worktree will be created.
- A caller that creates at once can pass `{ branch, base }` in props.

`factory-new-menu` (tab bar +) and `factory-menu` (a space's right-click menu) open
it, New worktree at 460×420 so the six-row list fits. Open and Remove
work as in Herdr's mod.

After a Herdr update, compare `main.js` with `~/.config/herdr-app/mods/worktree/main.js`
and bring upstream fixes across. It was ported from the
`herdr-worktree-start-point` patches (Herdr 0.1.16) onto Herdr 0.1.18's mod.
Herdr is Apache-2.0.
