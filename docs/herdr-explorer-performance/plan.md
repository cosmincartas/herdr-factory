# herdr-explorer performance: implementation plan

- **Subject:** the 11 findings of the performance review of `mods/herdr-explorer` (2026-11-24)
- **Source:** that review, in conversation. There is no specification file, so this is a plain plan:
  it has no `spec_sha256` and is not an `artifact: implementation-plan`. Finding ids P1–P11 stand in for requirement ids.
- **Repository baseline:** `cd8f7f9` on `main`
- **Working tree:** uncommitted changes in `README.md`, `layouts/herdr-factory.json`, `mods/factory-tabs`, `mods/factory-worktree`,
  and untracked `mods/factory-menu`, `mods/factory-spaces`. None are in `mods/herdr-explorer`; leave them alone.
- **Created:** 2026-11-24

## Findings in scope

| Id | Finding | Where |
|---|---|---|
| P1 | Search parse is quadratic on long lines and keeps the whole line as row text | `search.js:76-106`, `main.js:707-715` |
| P2 | No list is virtualized; a large tree exceeds the render budget | `main.js:862-880` |
| P3a | The tree waits for `git status` before it shows a listing | `main.js:161-188` |
| P3b | Every refresh re-lists every open folder, one at a time, and recomputes the git top | `main.js:170-176` |
| P3c | Watch batches are not debounced; a Find query re-lists the checkout on each batch | `main.js:147-155` |
| P3d | The 10 s timer refreshes even while the local watch works | `main.js:76` |
| P4 | Find files rescans and fully sorts on every keystroke | `search.js:44-54` |
| P5 | A folder with very many entries costs a full glob expansion per listing | `listing.js:7-9` |
| P6 | `rows()` and `resultRows()` are rebuilt several times per key press | `main.js:214-227`, `main.js:320-327` |
| P7 | Each render reads `focused()` and `panes()` three times and parses localStorage | `main.js:109-115`, `router.js:42-84` |
| P8 | A new search starts while the previous `rg` still runs | `main.js:300-318` |
| P9 | Reveal loads ancestor folders one at a time | `main.js:442-447` |
| P10 | `herdr-explorer find` and `search` always sleep 0.3 s | `bin/herdr-explorer:35-44` |
| P11 | Ctrl+click spawns `test -d` and queues through a shell | `link.js:14-17`, `router.js:108-119` |

## Repository findings

- **Engine and budgets.** Herdr runs mods in QuickJS (`gpui_shell::engine::quickjs`). Under `herdr-app check`, a script call is
  interrupted at about 500 ms in `init` and about 50 ms in `render`. The interrupt is uncatchable, so `finally` blocks do not run.
  These budgets are observed, not documented, and were only observed in check mode; the live app was not tested.
- **Measured in QuickJS** (`herdr-app check` on a copy of the mod with a timing harness, gpui-shell 0.7.1, this machine):

  | What | Result |
  |---|---|
  | Tree `render()`, script side | 1,000 rows 17 ms; 2,000 rows 31 ms; 3,000 rows 47 ms; 4,000 and 5,000 rows interrupted |
  | Search `render()` | 2,100 rows 38 ms |
  | `rows()` | 5,000 rows 2 ms |
  | `findFiles`, 50,000 paths | no match 50 ms; `src` 186 ms; `s` 230 ms |
  | `byteToIndex` over one line | 9 KB with 100 submatches 71 ms; 23 KB with 250 submatches interrupted |
  | One linear `codePointAt` pass | 372 KB 25 ms; 3.7 MB 243 ms |
  | `JSON.parse` of one 6 MB match record | 33 ms |
  | `TextEncoder` / `TextDecoder` | not available |

- **Measured elsewhere.**
  - ripgrep 15.2.0 with `--json` ignores `--max-columns`: one 3.7 MB line came back as a 6,016,226-character record.
  - In Node, `searchContent` took 3,105 ms on a 363 KB line with 4,000 submatches.
  - The listing script took about 800 ms on a 100,000-entry folder and 3 ms on the repo root; 31 sequential listings took 38 ms.
  - `git status` took 2 ms here, on 75 files, so its cost on a large repository is unmeasured.
- **Entry points.** `main.js:Explorer` (the view and all scheduling), `search.js:findFiles`, `search.js:searchContent`, `listing.js:listFolder`,
  `listing.js:gitMarks`, `router.js:Router`, `link.js:handleLink`, `bin/herdr-explorer`.
- **Contracts that bind the fixes** (from `gpui-kit.d.ts`):
  - `on_click` inside a virtual list's renderer throws; clicks go through `on_item_click(key)` on the list.
  - `uniform_list` and `list` ignore a scroll handle. Only `v_virtual_list` takes a `VirtualListScrollHandle`, which the cursor keys and `gw` need.
  - `watchFolder` resolves with the changed absolute paths; a batch that contains the root means refresh everything.
  - `exec` has no cancel handle. `window()?.visible` reports whether the window is presented.
  - The typings do not say whether `hover`, `tooltip` and `drag_paths` work on rows built in a virtual list's renderer.
- **Precedent.** Herdr's own `changes` mod uses `v_virtual_list` with a paired `Scrollbar` (`~/.config/herdr-app/mods/changes/main.js:322-324`).
  `mods/acp-view/bridge/` shows that a mod folder may hold non-mod files in a subfolder.
- **Tests.** The repo has none for this mod. Two facilities were proven in a scratch folder and Task 0 adds them:
  1. Node's test runner with `module.registerHooks` mapping `herdr`, `gpui-kit` and `gpui-base` to stubs. With about 30 lines of
     stubs the real `Explorer` class runs in Node, `render()` included. A probe showed 0 rows while `git status` was pending (P3a).
  2. A budget harness: copy the mod to a temp folder, add a `main.js` that subclasses `Explorer` and seeds state, and run `herdr-app check` on it.
     The host's interrupt is the oracle: exit 1 with `interrupted` when a call is over budget.
- **Limits.** `herdr-app check` does not run layout, so it never calls a virtual list's renderer and never settles async tasks.
  Row rendering inside a virtual list and all interaction can only be verified in the live app.

### Baseline verification

| Command | Source | Result | Exit | Duration | Note |
|---|---|---|---|---|---|
| `herdr-app check mods/herdr-explorer` | `herdr-app --help` | ran | 0 | 0.3 s | Prints `check passed`. A WARN about stranded script tasks is baseline noise. |
| `tsc -p jsconfig.json` | not declared; `jsconfig.json` is editor configuration | ran | not captured | 0.4 s | 291 errors, mostly implicit `any`. Not usable as a gate. |

## Decisions for you

Each has a recommendation; the tasks assume it.

1. **Where tests live.** `mods/herdr-explorer/test/`, so they ship with the linked mod folder as `acp-view/bridge/` does.
2. **Virtualization fallback.** If Task 4 finds that virtual rows cannot keep hover, tooltip or drag, the choice is to lose that feature on rows
   or to keep plain lists and lower the row cap to 2,500 (under the measured budget). Recommended: decide after Task 4 reports.
3. **Single-flight search.** A new query waits for the running `rg`, which can take up to its 15 s timeout, because `exec` cannot be cancelled. Recommended: accept.
4. **Find files tie order.** Equal-score, equal-length paths sort by code unit instead of locale. Recommended: accept; it removes `localeCompare` from the hot path.
5. **Folders over 500 entries.** The 500 shown are chosen in C-locale order through GNU `find`, `sort -z` and `head -z`, with today's glob loop as the fallback.
   Recommended: accept; `search.js` already relies on `head -z`.
6. **Live-app checks.** Task 4 and check H-1 need the running Herdr window. The implementer captures with `herdr-app shot`; you review.
7. **One adjacent bug.** A file change that lands while the file list is loading is lost (`main.js:152`, `main.js:240`). Task 8 fixes it because it rewrites that code. Say so if you want it left out.

## Gates

These apply after every task and in final verification. Run them from `mods/herdr-explorer`.

- **Commands:** `node --import ./test/hooks.mjs --test test/` exits 0 (every earlier check stays green), and `herdr-app check .` exits 0 and prints `check passed`.
- **Protected paths:** after Task 0, `test/hooks.mjs`, `test/stubs/`, `test/budget.sh` and `test/characterization.test.mjs` change only in a task that names them.
- **Dependencies:** no packages. Node built-ins, `sh` and tools the mod already calls (`rg`, `git`, `find`, `head`) only.
- **Scope:** changes stay inside `mods/herdr-explorer/`. A need outside it is reported, not made.
- **Behaviour:** keys, layout, colours and the README's documented behaviour stay as they are, except where a task says otherwise.
  A task that changes a documented limit updates the mod's `README.md`.

## Checks

A program decides every check except H-1. Commands run from `mods/herdr-explorer`. `T` stands for `node --import ./test/hooks.mjs --test`.
Budget checks depend on machine speed; their margins are sized from the measurements above.

```yaml
checks:
  - id: C-0a
    covers: [facility]
    level: unit
    written_by: Task 0
    passes_in: Task 0
    files: [test/hooks.mjs, test/stubs/herdr.mjs, test/stubs/ui.mjs, test/characterization.test.mjs]
    cmd: "T test/characterization.test.mjs"
    timeout_s: 60
    green: { exit: 0, match: "fail 0" }
    note: "Pins today's behaviour: findFiles ranking and hit positions on a fixture corpus, searchContent output for ASCII and non-ASCII lines, listFolder parsing and order, gitMarks marks and dirty folders, Explorer.rows() for a seeded tree."
  - id: C-0b
    covers: [facility]
    level: integration
    written_by: Task 0
    passes_in: Task 0
    files: [test/budget.sh, test/budget/tree-50.js]
    cmd: "sh test/budget.sh tree-50"
    timeout_s: 60
    green: { exit: 0, match: "check passed" }
  - id: C-1a
    covers: [P1]
    level: unit
    written_by: Task 1
    passes_in: Task 1
    files: [test/search-long-lines.test.mjs]
    cmd: "T test/search-long-lines.test.mjs"
    timeout_s: 120
    red: { exit: 1, match: "long line parsed in" }
    green: { exit: 0, match: "fail 0" }
    note: "A 363 KB line with 4,000 submatches parses in under 200 ms (3,105 ms today). Stored text is at most 500 characters, every range lies inside it and still covers the matched text, and col is the 1-based character column in the full line, for ASCII and non-ASCII lines."
  - id: C-1b
    covers: [P1]
    level: integration
    written_by: Task 1
    passes_in: Task 1
    files: [test/budget.sh, test/budget/parse-long-line.js]
    cmd: "sh test/budget.sh parse-long-line"
    timeout_s: 60
    red: { exit: 1, match: "interrupted" }
    green: { exit: 0, match: "check passed" }
    note: "In init: parseMatches over one 3.7 MB ASCII line with 40,000 submatches and one 300 KB non-ASCII line with 3,000."
  - id: C-2
    covers: [P3a]
    level: unit
    written_by: Task 2
    passes_in: Task 2
    files: [test/refresh-order.test.mjs]
    cmd: "T test/refresh-order.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "rows before git status returned" }
    green: { exit: 0, match: "fail 0" }
    note: "With git status pending, rows() holds the listing and cx.notify() has fired; marks arrive after it resolves. A root switch during the wait still discards the old result."
  - id: C-3a
    covers: [P4]
    level: integration
    written_by: Task 3
    passes_in: Task 3
    files: [test/budget.sh, test/budget/find-50k.js]
    cmd: "sh test/budget.sh find-50k"
    timeout_s: 60
    red: { exit: 1, match: "interrupted" }
    green: { exit: 0, match: "check passed" }
    note: "In init: findFiles('s') four times over 50,000 generated paths, so each call must average under about 110 ms (230 ms today)."
  - id: C-3b
    covers: [P4]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [test/find-files.test.mjs]
    cmd: "T test/find-files.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "narrowed from the previous query" }
    green: { exit: 0, match: "fail 0" }
    note: "Typing a query that extends the previous one returns the same result as a fresh search and examines only the previous matches. Results equal C-0a's pinned ranking, with ties in code-unit order."
  - id: C-5a
    covers: [P2, P6]
    level: integration
    written_by: Task 5
    passes_in: Task 5
    files: [test/budget.sh, test/budget/tree-5000.js, test/budget/found-5000.js]
    cmd: "sh test/budget.sh tree-5000 && sh test/budget.sh found-5000"
    timeout_s: 120
    red: { exit: 1, match: "interrupted" }
    green: { exit: 0, match: "check passed" }
    note: "tree-5000 is measured RED. found-5000 seeds 5,000 Find rows directly; Task 5 confirms its RED before changing code."
  - id: C-5b
    covers: [P2]
    level: unit
    written_by: Task 5
    passes_in: Task 5
    files: [test/virtual-tree.test.mjs]
    cmd: "T test/virtual-tree.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "v_virtual_list" }
    green: { exit: 0, match: "fail 0" }
    note: "The recording stub sees one v_virtual_list per list with the row count and height 24. Its renderer returns exactly the rows of the range asked for. on_item_click with a row's key does what a click does today (toggle a folder, open a file, select). j, k, gg, ge and reveal call scroll_to_item with the cursor's index. gw labels map to the rows the handle reports as visible."
  - id: C-6a
    covers: [P2, P6]
    level: integration
    written_by: Task 6
    passes_in: Task 6
    files: [test/budget.sh, test/budget/search-4000.js]
    cmd: "sh test/budget.sh search-4000"
    timeout_s: 60
    red: { exit: 1, match: "interrupted" }
    green: { exit: 0, match: "check passed" }
    note: "2,000 matches in 2,000 files is 4,000 rows. RED is extrapolated from 38 ms at 2,100 rows; Task 6 confirms it first."
  - id: C-6b
    covers: [P2]
    level: unit
    written_by: Task 6
    passes_in: Task 6
    files: [test/virtual-results.test.mjs]
    cmd: "T test/virtual-results.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "virtual list" }
    green: { exit: 0, match: "fail 0" }
    note: "Same contract as C-5b for search results: file rows fold, match rows open at line and column, the selection scrolls into view."
  - id: C-7
    covers: [P3b]
    level: unit
    written_by: Task 7
    passes_in: Task 7
    files: [test/refresh-targeted.test.mjs]
    cmd: "T test/refresh-targeted.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "folders listed" }
    green: { exit: 0, match: "fail 0" }
    note: "With a, b and c open: a batch naming a file in a lists only a; a batch under a closed folder lists nothing and still updates marks; a batch holding the root lists everything. A full refresh starts its listings together (at most 8 at once), not one by one. git rev-parse runs once per root, not once per refresh."
  - id: C-8
    covers: [P3c, P3d]
    level: unit
    written_by: Task 8
    passes_in: Task 8
    files: [test/refresh-schedule.test.mjs]
    cmd: "T test/refresh-schedule.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "refreshes for one burst" }
    green: { exit: 0, match: "fail 0" }
    note: "Five batches inside 50 ms cause one git status and, with a Find query set, one rg --files, 200 ms after the last. A timer tick does nothing while the local watch is live. It refreshes when the watch was rejected or the space is remote, and never while window().visible is false. A change that lands while the file list loads triggers one more listing."
  - id: C-9
    covers: [P8]
    level: unit
    written_by: Task 9
    passes_in: Task 9
    files: [test/search-single-flight.test.mjs]
    cmd: "T test/search-single-flight.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "concurrent rg" }
    green: { exit: 0, match: "fail 0" }
    note: "Three queries while the first rg is pending: one rg runs, then exactly one more with the last query, and its results are shown."
  - id: C-10
    covers: [P5]
    level: integration
    written_by: Task 10
    passes_in: Task 10
    files: [test/list-huge-folder.test.mjs]
    cmd: "T test/list-huge-folder.test.mjs"
    timeout_s: 180
    red: { exit: 1, match: "listed 100000-entry folder in" }
    green: { exit: 0, match: "fail 0" }
    note: "Real sh on a temp folder of 100,000 files: listFolder returns within 250 ms (about 800 ms today) with at most 501 entries. On small fixtures the output equals C-0a's: folders first, dotfiles in, .git out, symlinked folders as folders, names with spaces and newlines intact. The fallback path runs when the GNU tools are hidden from PATH."
  - id: C-11
    covers: [P7]
    level: unit
    written_by: Task 11
    passes_in: Task 11
    files: [test/render-reads.test.mjs]
    cmd: "T test/render-reads.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "host reads per render" }
    green: { exit: 0, match: "fail 0" }
    note: "One render() calls focused() once and panes() once (three each today), and parses the router store only when its raw string changed. A pairing written by link.js's own Router is still seen on the next render."
  - id: C-12
    covers: [P9]
    level: unit
    written_by: Task 12
    passes_in: Task 12
    files: [test/reveal.test.mjs]
    cmd: "T test/reveal.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "ancestor listings in flight" }
    green: { exit: 0, match: "fail 0" }
    note: "Revealing /repo/a/b/c/d.js starts the listings of the root, a, a/b and a/b/c together; the cursor lands on the file and its row is scrolled to."
  - id: C-13
    covers: [P10]
    level: integration
    written_by: Task 13
    passes_in: Task 13
    files: [test/cli.test.mjs, test/pending-command.test.mjs]
    cmd: "T test/cli.test.mjs test/pending-command.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "herdr-explorer find took" }
    green: { exit: 0, match: "fail 0" }
    note: "With a recording fake herdr-app first on PATH and a temp XDG_RUNTIME_DIR, 'herdr-explorer find foo' exits within 150 ms (300 ms or more today), leaves the request for the mod, and still selects and shows the panel. The Explorer applies a pending request once, at init and on a wake, and ignores one older than 5 s."
  - id: C-14
    covers: [P11]
    level: unit
    written_by: Task 14
    passes_in: Task 14
    files: [test/link.test.mjs]
    cmd: "T test/link.test.mjs"
    timeout_s: 60
    red: { exit: 1, match: "processes spawned for a ctrl+click" }
    green: { exit: 0, match: "fail 0" }
    note: "A link with a line number spawns no test -d. Once the explorer has stored its runtime folder, handleLink queues with writeTextFile and no shell; without it, the shell path still works. A folder link still returns 'pass'."
  - id: H-1
    covers: [P2]
    level: human
    written_by: Task 4
    passes_in: Task 6
    files: [test/capture.sh]
    cmd: "sh test/capture.sh"
    timeout_s: 120
    red: { exit: 1, match: "missing: virtual lists" }
    green: { exit: 0 }
    evidence: [test/evidence/tree.png, test/evidence/find.png, test/evidence/search.png, test/evidence/status.txt]
    review: "With the panel shown in the live app: the three lists look as before; hover highlights a row; the root and search file tooltips appear; dragging a row onto a terminal pastes its path; j and k keep the cursor in view without jumping; gw labels sit on the right rows; clicking toggles folders and opens files; a tree past 5,000 rows scrolls smoothly. status.txt (herdr-app status) reports no error for herdr-explorer and the folder holds no *.error file."
```

## Tasks

Order: 0 to 14 as numbered. Tasks 1, 2, 3, 9, 10, 13 and 14 depend only on Task 0 and can run in any order.

### Task 0: Test facilities

- **Findings:** none; every later check needs it.
- **Entry point:** new folder `mods/herdr-explorer/test/`.
- **Allowed areas:** `mods/herdr-explorer/test/`, and a "Development" section in the mod's `README.md` naming the two commands.
- **Depends on:** none.
- **TDD does not apply:** this task writes only test code.
- **Outcome:**
  - `test/hooks.mjs` registers resolve hooks for `herdr`, `gpui-kit` and `gpui-base`, and defines a `localStorage` global.
  - `test/stubs/herdr.mjs` gives scriptable `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `focused`, `panes`, `spaces` and `window`, with call counts.
    A test can also route `exec` to a real child process (C-10, C-13).
  - `test/stubs/ui.mjs` gives chainable element stubs that record calls, so a test can find a `v_virtual_list` call, run its renderer and fire `on_item_click`.
  - A fake `cx` helper has manual timers, so debounce and interval tests need no real waiting.
  - `test/budget.sh <scenario>` copies the mod (without `test/`) to a temp folder, renames `main.js`, installs `test/budget/<scenario>.js` as `main.js`,
    runs `herdr-app check`, prints its output and returns its exit code. It must not touch `~/.config/herdr-app`.
  - `test/characterization.test.mjs` pins today's behaviour as C-0a describes.
- **Verification:** C-0a and C-0b are green; `herdr-app check .` still passes with `test/` present.
- **Prerequisites:** Node 22.15 or later (26.13.1 here) and `herdr-app` on `PATH`.

### Task 1: Search survives long lines (P1)

- **Entry point:** `search.js:searchContent`, plus a required new export `search.js:parseMatches(stdout)` that returns `{ files, total, truncated }` and that `searchContent` calls.
- **Allowed areas:** `search.js`, `main.js` (`resultRow`), `test/`.
- **Depends on:** Task 0.
- **RED:** add C-1a and C-1b; both fail as their `red` says.
- **GREEN:**
  - Convert byte offsets without restarting from the line start for each submatch. Lines with no non-ASCII character need no walk at all.
  - Never walk further than the stored window: a 3.7 MB pass costs 243 ms in QuickJS.
  - Store a window of at most 500 characters around the first match, with ranges shifted and clipped to it.
  - Keep `line` and `col` exact for the full line. If `col` would need a long walk on a non-ASCII line, compute it when the row is opened.
  - `resultRow` keeps its "26 characters before the match" rule on the stored window.
- **REFACTOR:** split the output once instead of twice (`search.js:88`, `search.js:105`); drop the two `--max-columns` flags, which `--json` ignores.
- **Verification:** C-1a, C-1b, C-0a and the gates.

### Task 2: The tree shows before git answers (P3a)

- **Entry point:** `main.js:Explorer.refresh`.
- **Allowed areas:** `main.js`, `test/`.
- **Depends on:** Task 0.
- **RED:** C-2.
- **GREEN:** apply the listings and call `cx.notify()` as soon as they are in; fetch marks after and notify again.
  Keep the `gen` guard, the "update in place" rule for folders opened meanwhile, and the single-flight `loading` / `again` pair.
- **REFACTOR:** none required.
- **Verification:** C-2 and the gates.

### Task 3: Find files stays fast on 50,000 paths (P4)

- **Entry point:** `search.js:findFiles`; its caller `main.js:Explorer.filterFiles`.
- **Allowed areas:** `search.js`, `main.js`, `test/`.
- **Depends on:** Task 0.
- **RED:** C-3a and C-3b.
- **GREEN:**
  - Lowercase each path once per file list, not once per keystroke.
  - Keep the best 200 without sorting every match, and compare ties without `localeCompare` (decision 4).
  - When the query extends the previous one over the same file list, match only the previous matches.
  - If C-3a is still red after that, debounce the Find input by 80 ms when the list holds more than 10,000 paths.
- **REFACTOR:** remove the per-call closure in `match`.
- **Verification:** C-3a, C-3b, C-0a (ranking unchanged apart from tie order) and the gates. Update C-0a's tie expectations in this task only.

### Task 4: Spike: what a virtual list row can do

- **Findings:** P2.
- **Entry point:** a throwaway mod outside the repo, opened in the live app.
- **Allowed areas:** `mods/herdr-explorer/test/` only (`capture.sh` and a short `test/SPIKE.md` with the answers).
- **Depends on:** Task 0, and decision 6.
- **TDD does not apply:** it answers questions the typings leave open; no production code changes.
- **Questions to answer, each with a screenshot or log line:**
  1. Do `hover`, `tooltip` and `drag_paths` work on a row built in a `v_virtual_list` renderer, or do they throw?
  2. Does `VirtualListScrollHandle.scroll_to_item` leave an already visible row where it is, or pull it to the top on every call?
  3. Do `offset()` and `viewport_size()` on that handle give what `visibleRange` needs for `gw`?
  4. For search results, which is better: `v_virtual_list` with two fixed heights, or `list` with measured rows?
  5. Does the live app enforce the 50 ms render interrupt seen in check mode?
- **Outcome:** `test/SPIKE.md` records the answers, and `test/capture.sh` exists and fails with `missing: virtual lists` (H-1's RED).
- **Stop rule:** if answer 1 is "they throw", stop and ask for decision 2 before Task 5.

### Task 5: Virtualize the tree and Find files (P2, P6)

- **Entry point:** `main.js:Explorer.render` (the `tree` and `find` branches), `nodeRow`, `treeRow`, `foundRow`.
- **Allowed areas:** `main.js`, `test/`, the mod's `README.md`.
- **Depends on:** Task 4.
- **RED:** C-5a and C-5b. Confirm `found-5000` is red before changing code.
- **GREEN:**
  - Both lists become `v_virtual_list` with row height `ROW_H`, a `VirtualListScrollHandle` each, and a paired `Scrollbar`.
  - Row clicks move to `on_item_click`, keyed by row path.
  - The note above the rows moves out of the scrolled content or becomes row 0; `visibleRange` is adjusted to match.
  - `gw`, the cursor keys, reveal and the "first row while focused with no cursor" highlight behave as before.
- **REFACTOR (P6):** build the row array once per state change and reuse it in `render`, `listNote`, `treeKey`, `startJump` and `jumpKey`.
  The measured gain is small (2 ms per 5,000 rows), so it has no separate check.
- **Verification:** C-5a, C-5b and the gates. H-1 stays pending until Task 6.
- **README:** the "5,000 rows" limit is restated or removed to match what the code now does.

### Task 6: Virtualize search results (P2, P6)

- **Entry point:** `main.js:Explorer.render` (the `search` branch), `resultRow`, `resultRows`.
- **Allowed areas:** `main.js`, `test/`.
- **Depends on:** Task 1, Task 4, Task 5.
- **RED:** C-6a and C-6b. Confirm `search-4000` is red first.
- **GREEN:** the list type Task 4 chose; clicks through `on_item_click`; selection scrolls into view; `resultRows()` built once per change of results or folds.
- **REFACTOR:** share the list wiring with Task 5's.
- **Verification:** C-6a, C-6b and the gates. Then run H-1's capture and hand the evidence to the user.

### Task 7: Refresh lists only what changed (P3b)

- **Entry point:** `main.js:Explorer.watchRoot` and `main.js:Explorer.refresh`.
- **Allowed areas:** `main.js`, `listing.js`, `test/`.
- **Depends on:** Task 2.
- **RED:** C-7.
- **GREEN:**
  - Pass the watch batch to refresh. Re-list only open folders (and the root) that are the parent of a changed path; a batch holding the root re-lists all.
  - Marks are fetched on every refresh.
  - A full refresh (key `r`, the timer, a new root) starts its listings together, at most 8 at a time.
  - Remember the git top per root instead of calling `git rev-parse` on each refresh.
- **REFACTOR:** one helper for "list these folders" that Task 12 reuses.
- **Verification:** C-7, C-2 and the gates.

### Task 8: Debounce the watch and gate the timer (P3c, P3d)

- **Entry point:** `main.js:Explorer.watchRoot`, the two timers in `main.js:Explorer.init`, `main.js:Explorer.ensureFiles`.
- **Allowed areas:** `main.js`, `test/`, the mod's `README.md`.
- **Depends on:** Task 7.
- **RED:** C-8.
- **GREEN:**
  - Batches are collected for 200 ms after the last one, then refreshed once with the union of their paths.
  - The file list for Find is re-listed once per burst, and a change during a listing causes one more (decision 7).
  - The 10 s timer refreshes only when there is no live local watch (remote space, or the watch was rejected) and `window()?.visible` is not false.
- **REFACTOR:** cancel a superseded debounce timer instead of letting it fire and compare.
- **Verification:** C-8, C-7 and the gates.
- **README:** adjust "live updates through a folder watch (local) or a 10 s refresh" if the wording no longer fits.

### Task 9: One search at a time (P8)

- **Entry point:** `main.js:Explorer.runSearch` and `scheduleSearch`.
- **Allowed areas:** `main.js`, `test/`.
- **Depends on:** Task 0.
- **RED:** C-9.
- **GREEN:** while an `rg` runs, remember only the latest request and start it when the running one settles (decision 3). The spinner stays on throughout.
- **REFACTOR:** cancel the previous debounce timer.
- **Verification:** C-9 and the gates.

### Task 10: Fast listing of huge folders (P5)

- **Entry point:** `listing.js:listFolder` (the `LIST` script).
- **Allowed areas:** `listing.js`, `test/`, the mod's `README.md`.
- **Depends on:** Task 0.
- **RED:** C-10.
- **GREEN:** pick the first 501 names with GNU `find -printf`, `LC_ALL=C sort -z` and `head -z`, and type only those; fall back to today's loop when those tools are missing (decision 5).
  The entry format, the 500 cap, `.git` exclusion, the exit status for a missing folder and remote use through `exec`'s `on` stay as they are.
- **REFACTOR:** none required.
- **Verification:** C-10, C-0a and the gates.

### Task 11: One set of host reads per render (P7)

- **Entry point:** `main.js:Explorer.follow`, `router.js:Router.observe`, `Router.target`, `Router.stored`.
- **Allowed areas:** `main.js`, `router.js`, `test/`.
- **Depends on:** Task 5.
- **RED:** C-11.
- **GREEN:** read `focused()` and `panes()` once per render and pass them down; reparse the store only when its raw string changed.
  `link.js`, which has its own `Router`, must keep working with no arguments.
- **Note:** the gain is unmeasured and likely under a millisecond. Do it last among the `main.js` tasks; drop it if the test shows nothing worth the churn.
- **Verification:** C-11 and the gates.

### Task 12: Reveal loads ancestors together (P9)

- **Entry point:** `main.js:Explorer.reveal`.
- **Allowed areas:** `main.js`, `test/`.
- **Depends on:** Task 7.
- **RED:** C-12.
- **GREEN:** start all missing ancestor listings together with Task 7's helper, then set the cursor and scroll.
- **Note:** saves about 3 ms per ancestor locally; it matters on remote spaces.
- **Verification:** C-12 and the gates.

### Task 13: The CLI stops sleeping (P10)

- **Entry point:** `bin/herdr-explorer` (the `find` and `search` branch), `main.js:Explorer.watchReveals` and `Explorer.command`.
- **Allowed areas:** `bin/`, `main.js`, `test/`, the mod's `README.md`.
- **Depends on:** Task 0.
- **RED:** C-13.
- **GREEN:** follow the existing reveal mechanism.
  - The CLI writes the request (command, text, timestamp) to the runtime folder with a temp file and `mv`, selects and shows the panel, and wakes the mod with one `herdr-app do`. No `sleep`.
  - The mod reads a pending request when it starts, when woken, and when its folder watch fires. It applies it once and ignores one older than 5 s.
  - `herdr-explorer.find-files[:text]` and `herdr-explorer.search[:text]` from `keys.json` keep working.
- **REFACTOR:** share the "read once, dedupe" code with reveal.
- **Verification:** C-13 and the gates.

### Task 14: Ctrl+click without extra processes (P11)

- **Entry point:** `link.js:handleLink`, `router.js:Router.queue`.
- **Allowed areas:** `link.js`, `router.js`, `main.js`, `test/`.
- **Depends on:** Task 0.
- **RED:** C-14.
- **GREEN:** skip the folder test when the link carries a line number. The explorer stores its runtime folder in the shared router store, and `link.js` uses it to queue in-process, falling back to the shell.
- **Note:** a local spawn measured 2–3 ms, so this saves about 5 ms per click. It is the lowest-value task; skip it if you prefer.
- **Verification:** C-14 and the gates.

## Coverage

- **P1** → C-1a, C-1b in Task 1
- **P2** → C-5a, C-5b in Task 5; C-6a, C-6b in Task 6; H-1 after Task 6
- **P3a** → C-2 in Task 2
- **P3b** → C-7 in Task 7
- **P3c, P3d** → C-8 in Task 8
- **P4** → C-3a, C-3b in Task 3
- **P5** → C-10 in Task 10
- **P6** → C-5a in Task 5, C-6a in Task 6 (folded in as refactors)
- **P7** → C-11 in Task 11
- **P8** → C-9 in Task 9
- **P9** → C-12 in Task 12
- **P10** → C-13 in Task 13
- **P11** → C-14 in Task 14

## Final verification

- **Run:** every check above and every gate, on the integrated result.
- **Done when:**

| Finding | Type | Checks | Done when |
|---|---|---|---|
| P1 | checkable | C-1a, C-1b | Both green. |
| P2 | checkable and human | C-5a, C-5b, C-6a, C-6b, H-1 | All green, and the user approves H-1's evidence. |
| P3a–P3d | checkable | C-2, C-7, C-8 | All green. |
| P4 | checkable | C-3a, C-3b | Both green. |
| P5 | checkable | C-10 | Green. |
| P6 | checkable | C-5a, C-6a | Both green. |
| P7–P11 | checkable | C-11, C-9, C-12, C-13, C-14 | Each green, or the task is recorded as skipped by the user. |

- **Not covered by any check:** `git status` cost on a large repository (none was measured), and remote spaces (the README calls them untested).
