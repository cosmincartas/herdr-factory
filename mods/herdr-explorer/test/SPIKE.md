# Spike: what a virtual list row can do (Task 4, P2)

Answers the five questions Task 4 poses, for Task 5 (tree and Find files) and Task 6 (search
results). The evidence comes from a throwaway mod in a scratch Herdr home, driving itself from
`cx.timer` and from `herdr-app do` commands. No production code was changed.

## How it ran

- **Window:** a second `herdr-app` with `HERDR_APP_HOME=/run/user/1000/hx-spike`, its own home and
  socket, on the real display. Started in the background; stopped by PID afterwards. The scratch
  home's first-run welcome never closes from `overlay.close`, so the spike mod marks
  `frame.welcomed` in shared state from `init` and the window starts without it.
- **Mod:** `spike-mod/` outside this repository (`main.js`, `mod.json`), installed as
  `mods/spike` and shown by `layouts/spike.json` (the list; later a second block with a plain
  bash terminal for the drag test). It renders a `v_virtual_list` of 2,000 rows at 24 px
  (`row-NNNN`, a tooltip per row, a real file per row as its drag path) and a second list of
  4,000 rows whose `item_sizes` array alternates 22 and 18 px.
  Every row feature is added one at a time, each inside `try/catch`, so a throw is recorded
  instead of aborting the list.
- **Self-driving:** fifteen 500 ms ticks walk the feature mask (`none`, hover, hover+tooltip,
  hover+tooltip+drag_paths), then scroll through known rows, then switch list shapes, then stop
  and leave the full-feature 2,000-row list at the top for the pointer tests. Commands:
  `spike.busy[:ms]`, `spike.top`, `spike.scroll:N`, `spike.state`.
- **Window size in this run:** viewport `2520x1215` script px (about 50 rows of 24 px), so
  "visible" below means rows inside that viewport.
- **Evidence folder:** `/tmp/claude-1000/-home-cosmincartas-work-projects-herdr-factory/0e4dca19-14a6-49c2-829e-efeb22b9745a/scratchpad/shep-TKmZ/worker-4/evidence/`
  (referred to as `evidence/` below). `evidence/spike.log` is the mod's own log; the app's stderr
  in `app.log` carries the same `[spike]` lines.

## Answers

### 1. Do `hover`, `tooltip` and `drag_paths` work on a row built in a `v_virtual_list` renderer, or do they throw?

**They work. None of them throws.** The handler restriction applies to event handlers
(`on_click` and friends, which must move to `on_item_click`); `hover` is a style refinement,
`tooltip` a host label, and `drag_paths` a native drag source, and all three are accepted inside
the renderer.

Evidence from `evidence/spike.log` (all rows built inside the renderer):

- `t01 initial, hover+tooltip+drag_paths ... render#=1 ... errors=none`
- `t02 features=0, plain rows ... errors=none`
- `t03 features=1, hover only ... errors=none`
- `t04 features=3, hover+tooltip ... errors=none`
- `t05 features=7, hover+tooltip+drag_paths ... render#=5 ... errors=none`
- `t15 ... render#=16 ... errors=none` and `READY: ...` — the full-feature list is the one on
  screen for the pointer tests.
- `herdr-app status` found no error for the spike mod throughout.
- `evidence/tree-list-ready.png` / `evidence/crop-tree-rows.png`: the full-feature 2,000-row list
  drew correctly.

Pointer evidence, from the person acting on the live scratch window (no input automation):

- **Hover highlight: works.** The person hovered rows in the live window and the row under the
  pointer took the hover background inside the virtual list. Captured in
  `evidence/frames/f-062.png` (row 0108 highlighted), `evidence/frames/f-063.png` (row 0075
  highlighted) and `evidence/shot-13-tooltip-row0004.png`.
- **Tooltip: works.** After the pointer rested on a row, the host drew its tooltip label over the
  list: `evidence/shot-13-tooltip-row0004.png` (`evidence/crop-13-tooltip.png`) shows "row 0004
  — tooltip" over the highlighted row. The person saw the same on row-0002 first (text they
  reported: "row 0002 — tooltip").
- **Drag onto a terminal: retried inside one Herdr window.** The first attempt dragged a row from
  the scratch Herdr window onto a terminal in a different Herdr process and pasted nothing. That
  attempt does not answer the question (the explorer's rows and terminals live in one window), so
  it is not counted either way.
  A plain bash terminal (hc `t80`) was added to the scratch window next to the list for a retry in
  the same window, and the retry worked: dragging row-0004 onto the terminal prompt pasted
  `/tmp/.../evidence/drag/row-0004.txt` without Enter. `evidence/shot-15-drag-pasted.png`
  (`evidence/crop-15-drag-pasted.png`) shows the pasted path at the prompt, and
  `evidence/drop-terminal-read.txt` is `hc read t80` capturing the same line. The person's report
  matches.

### 2. Does `scroll_to_item` leave an already visible row where it is, or pull it to the top on every call?

**It leaves an already visible row alone, and reveals an off-screen row at the nearest edge
(minimal scroll), not at the top.** This is the behaviour `j`/`k` want. The typings' "`\"top\"`
(default) brings it to the near edge" is not what the list did here; do not rely on `"top"` to
place a row at the top.

From `evidence/spike.log` (uniform list, 24 px rows, top row 0, about 50 visible):

| Call | Before | After | Renderer range after |
|---|---|---|---|
| `scroll_to_item(5)` twice, row 5 visible at the top | `offset=0` | `offset=0` | `0..52`, still |
| `scroll_to_item(300)`, off screen below | `offset=0` | `offset=6009` | `250..303` (row 300 at the bottom edge) |
| `scroll_to_item(310)`, just below the viewport | `offset=6009` | `offset=6249` | `260..313` |
| `scroll_to_item(600)`, off screen | `offset=6249` | `offset=13209` | `550..603` |
| command `scroll:300` from the top | `offset=0` | `offset=6009` | `250..303` |
| command `scroll:280`, already visible | `offset=6009` | `offset=6009` | `250..303`, unchanged |
| command `scroll:5`, off screen above | `offset=6009` | `offset=120` | `5..57` (row 5 at the top edge) |
| command `top` | `offset=120` | `offset=0` | `0..52` |

The same holds for the two-height list: `scroll_to_item(2000)` landed at `offset=37471` with the
renderer range `1938..2003`, i.e. row 2000 at the bottom edge, not at the top.

**Requests need a layout.** A `scroll_to_item` is consumed once, on the next layout pass. In the
spike's first run the timer called it without `cx.notify()`, so consecutive requests coalesced and
only the last one took effect (`offset` stayed 0 until a later render). Every key handler in
`main.js` calls `cx.notify()` after moving the cursor, so this is not a problem for `j`/`k`/
`gg`/`ge`/reveal — but a call made without a following render will not show up yet.

### 3. Do `offset()` and `viewport_size()` on that handle give what `visibleRange` needs for `gw`?

**Yes, for a uniform row height.** `offset().y` and `viewport_size().height` are in the same px
the script writes (row height 24 here), and `main.js`'s formula from `main.js:503-510` reproduced
the renderer's first row exactly every time:

| offset | `visibleRange` computed by `main.js`'s formula | range the list renderer asked for |
|---|---|---|
| 0 | 0..49 | 0..52 |
| 6009 | 250..300 | 250..303 |
| 6249 | 260..310 | 260..313 |
| 13209 | 550..600 | 550..603 |

The first row matches exactly; the list's own range runs 3–4 rows further because it includes
overscan. So `gw` should keep using the handle and `visibleRange` (not the renderer's range), and
the overscanned rows stay unlabelled — as today. `content_size()` also includes the list's
padding.

**With two different row heights the uniform formula is wrong.** For the 22/18 px list the
handle reported `offset=37471`, the renderer asked for `1938..2003`, but `main.js`'s formula
(dividing by 24) computed `1561..1611`. A results list with two heights needs a prefix sum over
`item_sizes` and a binary search (the offsets are exact: row 1938 starts at
646×22 + 1292×18 = 37468, plus padding), or a single uniform height.

### 4. For search results, which is better: `v_virtual_list` with two fixed heights, or `list` with measured rows?

**`v_virtual_list` with two fixed heights.** Both were built and rendered in the live app, but
`list` cannot meet Task 6's contract:

- `list` takes no `VirtualListScrollHandle` (`gpui-kit.d.ts:20375-20390` and `:20407-20413`): it
  keeps its own position and is driven by a `Scrollbar` only. The explorer scrolls the results
  from code (`main.js:373`, `main.js:377`: `rscroll.scroll_to_item(this.ssel)`), and C-6b asks
  for "the selection scrolls into view", so `list` would lose that. The spike confirms there is
  no handle: `t14 list mode ... list takes no VirtualListScrollHandle, so code cannot scroll it`.
- `list` enters the host once per visible row per frame; `v_virtual_list` enters it once per
  frame however many rows are visible (`gpui-kit.d.ts:20375`). For 4,000 results that is the
  difference between one and about 60 host calls per frame.
- Two fixed heights are known statically (a file row is the 6 px top padding plus the 22 px row
  = 28 px; a match row is the 18 px minimum plus its 1 px vertical padding ≈ 20 px), so
  `item_sizes` can be an array of exactly `item_count` heights. The spike proved a 4,000-entry
  mixed array works: `t11 mixed heights, item_sizes array of 22 and 18 ... content=(2520x77336)`,
  and `scroll_to_item` landed exactly (`t12`, `t13`).
- What it costs: `gw`/`visibleRange` must map `offset` through the heights (prefix sums, answer
  3). That is one array per result set, cheap next to the rows themselves.

### 5. Does the live app enforce the 50 ms render interrupt seen in check mode?

**Yes.** A busy render in `render()` was interrupted in the live app, and a shorter one was not:

- **40 ms:** completed. `evidence/spike.log`: `armed 40 ms busy render` then
  `busy render finished: 40 ms`; the frame committed normally
  (`evidence/shot-08-busy40.png`, `evidence/crop-08-busy40.png`).
- **60 ms:** interrupted. The window showed "This view could not be re-rendered; showing the last
  version that worked / Interrupted" (`evidence/shot-07-busy60.png`,
  `evidence/crop-07-busy60.png`); no `busy render finished` line was logged.
- **200 ms:** interrupted the same way (`evidence/shot-06-after-busy.png`,
  `evidence/crop-busy200-interrupted.png`).
- `herdr-app status` does not report the interrupt as a mod error, and the mod stays alive: its
  `spike.state` command still answered after an interrupt, and the next successful render (the
  40 ms one) replaced the message with the normal frame. Observed budget: over 40 ms and at most
  60 ms, consistent with the ~50 ms seen under `herdr-app check`.
- Normal renders of the virtual lists were `0–1 ms` (`last=0ms`/`last=1ms` in every tick), so the
  virtual render path has ample headroom on its own.

## Notes for Tasks 5 and 6

- Clicks still go through `on_item_click` on the list; only event handlers are forbidden in the
  renderer. `hover`, `tooltip` and `drag_paths` may be called per row.
- `scroll_to_item` is a minimal reveal: already-visible rows do not move, off-screen rows land at
  the nearest edge. Requests are consumed on the next layout — keep the `cx.notify()` that key
  handlers already do.
- Keep `gw`'s `visibleRange` on the handle (answer 3). For search results with two heights,
  either build a prefix sum over `item_sizes` or use one uniform height; the uniform-by-24
  formula is wrong with mixed heights.
- `test/capture.sh` (H-1) treats a list as virtual when `main.js` has `v_virtual_list` and no
  plain `overflow_y_scrollbar` row area is left. It is RED now with `missing: virtual lists`; it
  captures `test/evidence/tree.png`, `find.png`, `search.png` and `status.txt` against a window
  selected by `HERDR_APP_HOME`, driving Find and Search through the mod's own commands. It
  expects a freshly started explorer in the tree view (it cannot send Escape).
- The scratch home's welcome screen does not close from `herdr-app do overlay.close`; a mod can
  set shared `frame.welcomed` from `init`, and the next start skips it.
