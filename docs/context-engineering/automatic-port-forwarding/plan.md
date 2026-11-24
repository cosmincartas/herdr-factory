---
schema_version: 1
artifact: implementation-plan
subject: "automatic-port-forwarding"
spec: "spec.md"
spec_sha256: "becfa7c0a5f3ead3efceb226052aad5ea76ba9077889a1a948399f45fd4263b5"
repository_baseline: "cd8f7f9807c0bdccb97dbe295eee929f70c3f5cf"
working_tree: "clean except the untracked planning artifacts docs/context-engineering/automatic-port-forwarding/spec.md and plan.md"
created: "2026-11-24"
updated: "2026-11-24"
---

# Automatic Port Forwarding Implementation Plan

## Source and Execution Boundaries

This plan implements only the included requirements of the referenced specification.
Before execution, confirm that the specification's exact content matches `spec_sha256`.
Resolve relative specification paths against this plan's folder.
Accept existing absolute source paths as written. Verify source existence and hash equality regardless of path format.
The intent was supplied in conversation. The specification records it under "Intent and Delivery Scope" with `intent_sha256: not applicable`.
Inspect relevant repository changes against the baseline, including working-tree changes. Review affected tasks before execution.
Execution state belongs to the implementer, not this planning artifact.

## Supporting Sources

None. UI-1's mock is inline in the specification.

## Implementation Discretion

Preserve approved behavior, required signatures, contracts, invariants, architecture, and acceptance conditions.
The specification's binding items are:

- The `Deps` interface and the exported `forward.js` functions.
- The [Forward labels](spec.md#forward-labels) and [Forward start command](spec.md#forward-start-command) contracts.
- The link rule.
- The 250 ms poll interval and the 20 s readiness deadline.
- The notification and error texts.

Choose private helpers, the view's internal structure, and incidental wiring within those constraints.
Trace downstream from each task's entry point. The entry point is not an exhaustive list of affected files.
Check existing code, standard libraries, native capabilities, and installed dependencies before adding abstractions or dependencies.
Useful precedents:

- `mods/acp-view/link.js` for `hc run --bg --json` parsing and `cx.sleep`.
- `mods/herdr-explorer/link.js:handleLink` for link-handler shape and `notify`.
- `mods/factory-worktree/main.js:Worktree` for dialog inputs.

Justify additions through a present requirement and an unmet need. Obtain specification approval for consequential technology changes.

## Correction Rules

Stop dependent work when a change affects approved scope, acceptance, UI, contracts, or architecture.
Request specification review through `design-specs` or the original specification workflow. Do not silently change upstream artifacts.
For changed intent, request intent review first. Reassess downstream approvals after upstream correction.
For task order, grouping, or verification changes within the approved specification, request plan revision through `implementation-plan`.
Private structural changes within approved constraints require verification, not another design approval.
Do not refresh source hashes without reviewing changes and obtaining approval for affected content.
If C-H1 shows that Herdr never passes remote-terminal URL clicks to `link.js`, stop. FR-1 is then infeasible as designed (spec "Open Issues"), and the specification needs review.

## Approval Record

- **Decision:** delegated approval
- **Evidence:** `/quickie` invocation on 2026-11-24, after all plan completion checks passed.
- **Limits:** quickie limited delegation covers routine plan approval only. The user has not reviewed this plan directly. The Task 0 review below is also delegated unless the user performs it. Human checks C-H1 and C-H2 stay `pending review` until the user approves their evidence.

## Repository Findings

- **Entry points and callers:** None exist yet for this feature.
  - Herdr calls a mod's `link.js:handleLink` for matching link rules, as in `mods/herdr-explorer/link.js:handleLink`.
  - The layout's root `link_handlers` is `["herdr-explorer"]` (`layouts/herdr-factory.json`).
  - Dialog mods open through `mod.open` with the `mod.json` `overlay` size, as in `mods/herdr-tui-prefix/mod.json` and `~/.config/herdr-app/keys.json` `"ctrl-b": "mod.open:herdr-tui-prefix"`.
  - `install.sh` links every `mods/*/` folder into `~/.config/herdr-app/mods`.
- **Tests and commands:**
  - The repository has no tests, no package manifest at the root, and no CI.
  - `herdr-app check <mod folder>` is Herdr's required mod check (`~/.config/herdr-app/AGENTS.md` "Check before you finish").
  - Node 26.13.1 is installed, and `node --test` imports ES-module `.js` files from folders with no `package.json` (scratch probe, 2026-11-24).
- **Contracts and conventions:**
  - Mods import `herdr`, which Node cannot load, so the testable core must not import it (spec HLD).
  - `hc run --bg --json` prints `{"address": …}` (`mods/acp-view/link.js:147`).
  - `hc ls --json` terminal entries carry no labels, but `--label k=v` filters them. `hc get <t> --json` returns `labels`, `state` (`"live"`) and `exit_code` (observed 2026-11-24).
  - `hc run --name` is unique among live terminals (`hc run --help`).
  - Herdr writes `gpui-kit.d.ts` and `jsconfig.json` into each mod folder. `.gitignore` ignores `gpui-kit.d.ts` and `*.error`; `jsconfig.json` is committed in the other mods.
- **Existing changes:** none besides the planning artifacts.
- **Known failures or limits:**
  - The only configured SSH machine, `framework`, was unreachable on 2026-11-24 (`hc machine ls --json`: `state: "unreachable"`, SSH connection timed out). C-H1 and C-H2 cannot run until a reachable SSH machine exists.
  - SSH to `localhost` fails host-key verification (no known host key), so it is not used as a test fixture.

### Baseline Verification

| Command | Source | Result | Exit code | Duration | Timeout | Failing tests or skip reason |
|---|---|---|---|---|---|---|
| `herdr-app check mods/herdr-tui-prefix` | `AGENTS.md` "Check before you finish" | ran | 0 | 0.26 s | 30 s | none; one `WARN` about stranded reload tasks |
| `herdr-app check` on the other mods | `AGENTS.md` | skipped | – | – | – | Their `init` may start processes during a check (`acp-view` bridges, `herdr-explorer` listings), and this scope does not change them. |
| `herdr-app check <scratch folder>` probes | `AGENTS.md` | ran | 1 / 0 / 1 | < 1 s | 30 s | Probes only, outside the repo: a folder with only `forward.js` gives `check failed`, a `mod.json` + `link.js` folder gives `check passed`, a missing folder gives `check failed`. |
| typecheck, lint, build | none declared | skipped | – | – | – | No manifest script, Makefile or CI names one. The `jsconfig.json` files configure editors only. |
| `node --test --test-reporter=tap tests/port-forward/` | spec Verification Facilities (new) | skipped | – | – | – | Created by Task 0 and Task 1; does not exist yet. |

## Gates

- **Commands:**
  - From Task 1 on: `node --test --test-reporter=tap tests/port-forward/` exits 0 with `# fail 0`. The one exception is during Task 0, where C-4 is expected RED.
  - From Task 6 on: `herdr-app check mods/port-forward` exits 0 with `check passed: mods/port-forward`.
  - Re-run every automated check that passed earlier.
  - No typecheck, lint or build command is declared.
- **Protected paths:**
  - The Task 0 files: `tests/port-forward/acceptance.test.mjs`, `tests/port-forward/capture-click.sh` and `tests/port-forward/capture-dialog.sh`.
  - `mods/acp-view/bridge/package-lock.json`, `install.sh`, `watch.sh` and `.gitignore`.
  - `layouts/herdr-factory.json`, except its root `link_handlers` in Task 6.

  A change to a protected path fails the gate.
- **Dependencies:** No new packages. The specification's Technology Stack lists no new package; Node's built-in `node:test` is not a package.
- **Scope:** A change outside the task's allowed areas fails the gate. The implementer reports the need instead.

## Checks

Patterns are line-anchored regular expressions matched against the command's combined output.
A `--test-name-pattern` that matches no test still exits 0, so every unit GREEN requires its `^ok` line.
Test names start with the covered identifier and a colon, for example `FR-1: forwards and opens a remote localhost URL`.
Unit tests load `mods/port-forward/forward.js` through a loader that throws `port-forward core missing: <export>` when the module or export is absent.
That makes RED name the missing behavior; the scratch probe confirmed the TAP output `not ok 2 - FR-1: …` with `error: 'port-forward core missing: handleClick'`.
RED for a check written against an existing export comes from a failed assertion on the oracle's value.

```yaml
checks:
  - id: C-1
    covers: [FR-1]
    level: unit
    written_by: Task 1
    passes_in: Task 1
    files: [tests/port-forward/click.test.mjs, tests/port-forward/fakes.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-1:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-1:" }
    green: { exit: 0, match: "^ok \\d+ - FR-1:" }
  - id: C-2
    covers: [NFR-1]
    level: unit
    written_by: Task 1
    passes_in: Task 1
    files: [tests/port-forward/click.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^NFR-1:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - NFR-1:" }
    green: { exit: 0, match: "^ok \\d+ - NFR-1:" }
  - id: C-3
    covers: [NFR-2]
    level: unit
    written_by: Task 1
    passes_in: Task 1
    files: [tests/port-forward/click.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^NFR-2:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - NFR-2:" }
    green: { exit: 0, match: "^ok \\d+ - NFR-2:" }
  - id: C-4
    covers: [DoD-3, FR-3]
    level: unit
    written_by: Task 0
    passes_in: Task 1
    files: [tests/port-forward/acceptance.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^DoD-3:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - DoD-3:" }
    green: { exit: 0, match: "^ok \\d+ - DoD-3:" }
  - id: C-5
    covers: [F-10]
    level: unit
    written_by: Task 1
    passes_in: Task 1
    files: [tests/port-forward/click.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-10:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-10:" }
    green: { exit: 0, match: "^ok \\d+ - F-10:" }
  - id: C-6
    covers: [FR-2]
    level: unit
    written_by: Task 2
    passes_in: Task 2
    files: [tests/port-forward/reuse.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-2:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-2:" }
    green: { exit: 0, match: "^ok \\d+ - FR-2:" }
  - id: C-7
    covers: [F-6]
    level: unit
    written_by: Task 2
    passes_in: Task 2
    files: [tests/port-forward/reuse.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-6:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-6:" }
    green: { exit: 0, match: "^ok \\d+ - F-6:" }
  - id: C-8
    covers: [FR-4, F-4]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-4:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-4:" }
    green: { exit: 0, match: "^ok \\d+ - FR-4:" }
  - id: C-9
    covers: [F-1]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-1:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-1:" }
    green: { exit: 0, match: "^ok \\d+ - F-1:" }
  - id: C-10
    covers: [F-2]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-2:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-2:" }
    green: { exit: 0, match: "^ok \\d+ - F-2:" }
  - id: C-11
    covers: [F-3]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-3:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-3:" }
    green: { exit: 0, match: "^ok \\d+ - F-3:" }
  - id: C-12
    covers: [NFR-3]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^NFR-3:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - NFR-3:" }
    green: { exit: 0, match: "^ok \\d+ - NFR-3:" }
  - id: C-13
    covers: [F-5]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-5:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-5:" }
    green: { exit: 0, match: "^ok \\d+ - F-5:" }
  - id: C-14
    covers: [F-7]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-7:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-7:" }
    green: { exit: 0, match: "^ok \\d+ - F-7:" }
  - id: C-15
    covers: [F-11]
    level: unit
    written_by: Task 3
    passes_in: Task 3
    files: [tests/port-forward/failures.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-11:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-11:" }
    green: { exit: 0, match: "^ok \\d+ - F-11:" }
  - id: C-16
    covers: [FR-6]
    level: unit
    written_by: Task 4
    passes_in: Task 4
    files: [tests/port-forward/manage.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-6:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-6:" }
    green: { exit: 0, match: "^ok \\d+ - FR-6:" }
  - id: C-17
    covers: [FR-8]
    level: unit
    written_by: Task 4
    passes_in: Task 4
    files: [tests/port-forward/manage.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-8:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-8:" }
    green: { exit: 0, match: "^ok \\d+ - FR-8:" }
  - id: C-18
    covers: [F-9]
    level: unit
    written_by: Task 4
    passes_in: Task 4
    files: [tests/port-forward/manage.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-9:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-9:" }
    green: { exit: 0, match: "^ok \\d+ - F-9:" }
  - id: C-19
    covers: [FR-7]
    level: unit
    written_by: Task 5
    passes_in: Task 5
    files: [tests/port-forward/form.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^FR-7:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - FR-7:" }
    green: { exit: 0, match: "^ok \\d+ - FR-7:" }
  - id: C-20
    covers: [F-8]
    level: unit
    written_by: Task 5
    passes_in: Task 5
    files: [tests/port-forward/form.test.mjs]
    cmd: "node --test --test-reporter=tap --test-name-pattern='^F-8:' tests/port-forward/"
    timeout_s: 60
    red: { exit: 1, match: "^not ok \\d+ - F-8:" }
    green: { exit: 0, match: "^ok \\d+ - F-8:" }
  - id: C-21
    covers: [FR-1]
    level: integration
    written_by: Task 6
    passes_in: Task 6
    files: [mods/port-forward/mod.json, mods/port-forward/link.js]
    cmd: "herdr-app check mods/port-forward"
    timeout_s: 60
    red: { exit: 1, match: "^check failed: mods/port-forward" }
    green: { exit: 0, match: "^check passed: mods/port-forward" }
  - id: C-22
    covers: [FR-5]
    level: integration
    written_by: Task 7
    passes_in: Task 7
    files: [mods/port-forward/main.js, mods/port-forward/mod.json]
    cmd: "test -f mods/port-forward/main.js || { echo 'port-forward dialog view missing'; exit 1; }; herdr-app check mods/port-forward"
    timeout_s: 60
    red: { exit: 1, match: "^port-forward dialog view missing" }
    green: { exit: 0, match: "^check passed: mods/port-forward" }
  - id: C-23
    covers: [FR-5]
    level: unit
    written_by: Task 8
    passes_in: Task 8
    files: [README.md]
    cmd: "grep -n 'mods/port-forward/' README.md && grep -n 'Port forwards' README.md || { echo 'README lacks port-forward docs'; exit 1; }"
    timeout_s: 10
    red: { exit: 1, match: "^README lacks port-forward docs" }
    green: { exit: 0, match: "mods/port-forward/" }
  - id: C-H1
    covers: [DoD-1]
    level: human
    written_by: Task 0
    passes_in: Task 6
    files: [tests/port-forward/capture-click.sh]
    cmd: "PF_MACHINE=<ssh machine name> tests/port-forward/capture-click.sh"
    timeout_s: 600
    red: { exit: 1, match: "^no port forward for local port 18765 appeared" }
    green: { exit: 0, match: "^evidence saved" }
    evidence: [~/.local/state/herdr-factory/port-forward-evidence/click-app.png, ~/.local/state/herdr-factory/port-forward-evidence/click-curl.txt, ~/.local/state/herdr-factory/port-forward-evidence/click-ss.txt, ~/.local/state/herdr-factory/port-forward-evidence/click-forward.json]
    review: "The user saw the page open in the browser; click-curl.txt contains the marker the script served; click-ss.txt lists only 127.0.0.1 and [::1] local addresses (spec DoD-1)."
  - id: C-H2
    covers: [DoD-2, FR-5]
    level: human
    written_by: Task 0
    passes_in: Task 7
    files: [tests/port-forward/capture-dialog.sh]
    cmd: "PF_MACHINE=<ssh machine name> tests/port-forward/capture-dialog.sh"
    timeout_s: 600
    red: { exit: 1, match: "^no port forward for local port 28766 appeared" }
    green: { exit: 0, match: "^evidence saved" }
    evidence: [~/.local/state/herdr-factory/port-forward-evidence/dialog-open.png, ~/.local/state/herdr-factory/port-forward-evidence/dialog-added.png, ~/.local/state/herdr-factory/port-forward-evidence/dialog-added.json, ~/.local/state/herdr-factory/port-forward-evidence/dialog-stopped.png, ~/.local/state/herdr-factory/port-forward-evidence/dialog-stopped.json]
    review: "dialog-open.png shows the 'Port forwards' dialog; dialog-added.png shows the new forward's row and dialog-added.json lists it; dialog-stopped.png shows no such row and dialog-stopped.json lists none (spec DoD-2)."
```

### Human capture scripts

Both scripts follow the same pattern:

- They exit 2 with a line starting `prerequisite:` when `PF_MACHINE` is unset, the machine's `hc machine ls --json` state is not `ready`, Herdr is not running (`herdr-app status` fails), or `curl` is missing.
- Evidence goes to `~/.local/state/herdr-factory/port-forward-evidence/`, outside the repository.
- Each waits at most `PF_WAIT_S` seconds (default 180) for the user's action.
- Each removes the terminals it started (`hc kill` and `hc rm`) before it exits.

The user performs the clicks and typing that Herdr's command line cannot drive. The scripts capture everything else.

- **`capture-click.sh`:**
  1. Writes an `index.html` with a random marker to `/tmp/pf-e2e` on `PF_MACHINE` (`hc exec --on`).
  2. Opens a space on that machine running `python3 -m http.server 18765 --bind 127.0.0.1 --directory /tmp/pf-e2e`, with `herdr-app do space.new` and `machine` and `argv`. The server prints `http://127.0.0.1:18765/`.
  3. Asks the user to Ctrl+click that URL.
  4. Waits for `hc ls --json --label port-forward.local=18765` to list a terminal. On timeout it prints `no port forward for local port 18765 appeared` and exits 1.
  5. Captures `herdr-app shot`, `curl -s http://localhost:18765/`, `ss -ltnH 'sport = :18765'` and `hc get <forward> --json`.
  6. Prints `evidence saved`, and exits 0 only when the curl output contains the marker.
- **`capture-dialog.sh`:**
  1. Runs `herdr-app do mod.open '{"name":"port-forward"}'` and captures `dialog-open.png`.
  2. Asks the user to choose `PF_MACHINE`, enter remote port 18766 and local port 28766, then click Add.
  3. Waits for `hc ls --json --label port-forward.local=28766`. On timeout it prints `no port forward for local port 28766 appeared` and exits 1.
  4. Captures `dialog-added.png` and `.json`.
  5. Asks the user to click Stop, then waits for the listing to become empty. On timeout it prints `port forward 28766 was not stopped` and exits 1.
  6. Captures `dialog-stopped.png` and `.json`, and prints `evidence saved`.

## Tasks

### Task 0: Acceptance Checks

- **Requirements:** DoD-1, DoD-2, DoD-3, FR-3, FR-5
- **Checks written:** C-4, C-H1, C-H2
- **Outcome:** Every listed check exists and gives its RED result. No production code changes.
  - C-4 fails with `port-forward core missing: handleClick`. Its scenario is the FR-3 oracle: a click on `http://localhost:3000/` with `source.machine: null` returns `"pass"`, and the fake `hc` and `exec` receive no calls. The file contains its own loader and fakes.
  - C-H1 and C-H2 give RED only when a reachable SSH machine exists. Otherwise each exits 2 with `prerequisite:`. Record that as unexecuted, not as RED, and continue; DoD-1 and DoD-2 cannot be signed off until the checks run.
- **Review:** a reviewer under delegated approval, or the user, compares each test and script with its oracle and its DoD-* item before other tasks start.
- **Allowed areas:** `tests/port-forward/` (the three files above only).
- **After review:** The files of these checks are protected paths.

### Task 1: Click on a remote localhost URL starts a loopback-only forward and opens it

- **Requirements:** FR-1, FR-3, NFR-1, NFR-2, F-10
- **Design references:**
  - spec Click
  - Ensure a forward, steps 2 to 4 (start path and readiness success only)
  - Forward start command, Forward labels
  - Models (`ClickTarget`, `ForwardRequest`), Interfaces (`Deps`)
  - Functions: `forwardTarget`, `sshMachines`, `ensureForward`, `handleClick`
- **Entry point:** new `mods/port-forward/forward.js:handleClick`
- **Allowed areas:** `mods/port-forward/forward.js`, `tests/port-forward/` (new files `fakes.mjs` and `click.test.mjs` only)
- **Depends on:** Task 0
- **RED:**
  - Add `tests/port-forward/fakes.mjs`. It provides a scenario-driven fake `Deps` that answers the herdr-core shapes in spec "herdr-core commands consumed" and `ss`/`xdg-open`/`sleep`, records every call, and advances a fake clock on `sleep`. It also provides the `loadCore` loader.
  - Add `click.test.mjs` with these tests:
    - `FR-1:` the exact start argv and `xdg-open http://localhost:5173/app`, result `"handled"`.
    - `NFR-1:` every built argv has `-L` followed by `localhost:…`.
    - `NFR-2:` every built argv contains `-o`, `BatchMode=yes`.
    - `F-10:` the four URLs give `null`.
  - Checks C-1, C-2, C-3 and C-5 give their RED result.
- **GREEN:**
  - Implement `forwardTarget`, `sshMachines` and `handleClick` (pass path, SSH lookup, open).
  - Implement `ensureForward`'s start path: the `ss` pre-check, `hc run` with the exact contract argv, and polling every 250 ms until `ss` lists the port.
  - `forward.js` imports nothing.
- **REFACTOR:** Extract argv and label builders as private helpers if useful. Keep exports exactly as in the spec Interfaces.
- **Verification:** Checks C-1, C-2, C-3, C-4 and C-5 give their GREEN result, and the gates pass.
- **Prerequisites:** none

### Task 2: A repeated or concurrent click reuses the live forward

- **Requirements:** FR-2, F-6
- **Design references:** spec Ensure a forward, steps 1 and 3; Forward labels; F-6
- **Entry point:** `mods/port-forward/forward.js:ensureForward`
- **Allowed areas:** `mods/port-forward/forward.js`, `tests/port-forward/` (new `reuse.test.mjs`; `fakes.mjs` may grow)
- **Depends on:** Task 0, Task 1
- **RED:**
  - Add `reuse.test.mjs` with these tests:
    - `FR-2:` a live `t9` labeled framework/5173/localhost/5173 means no `run` and the URL opens.
    - `F-6:` `hc run` exits 1, then `hc ls` lists a matching forward, so the result is `{ok: true, reused: true}`.
  - C-6 and C-7 give their RED result through failed assertions (an extra `run` call, or `ok: false`).
- **GREEN:** Look up the live forward by `port-forward=1` and `port-forward.local=<port>` labels plus `hc get --json`. Reuse a matching forward. After a failed `hc run`, look up once more.
- **REFACTOR:** Share the label parsing that Task 4's `listForwards` will use, as a private helper.
- **Verification:** Checks C-6 and C-7 give their GREEN result, and the gates pass.
- **Prerequisites:** none

### Task 3: Failed forwards notify, never open the browser, and leave no forward terminal

- **Requirements:** FR-4, NFR-3, F-1, F-2, F-3, F-4, F-5, F-7, F-11
- **Design references:** spec Ensure a forward, steps 1 to 5; Click, steps 2 and 4; Failure Model F-1 to F-5, F-7 and F-11; UI-2
- **Entry point:** `mods/port-forward/forward.js:handleClick` and `ensureForward`
- **Allowed areas:** `mods/port-forward/forward.js`, `tests/port-forward/` (new `failures.test.mjs`; `fakes.mjs` may grow)
- **Depends on:** Task 0, Task 2
- **RED:**
  - Add `failures.test.mjs` with one test per check (`FR-4:`, `F-1:`, `F-2:`, `F-3:`, `NFR-3:`, `F-5:`, `F-7:`, `F-11:`), using the spec's exact triggers and texts.
  - `NFR-3:` asserts that the fake clock reads at most 20 250 ms when `handleClick` resolves.
  - C-8 to C-15 give their RED result through failed assertions on notification texts, `hc` calls or the clock.
- **GREEN:**
  - Implement each failure response, with exact notification title and body texts.
  - `hc rm` after an exited `ssh`; `hc kill` then `hc rm` at the 20 s deadline.
  - Return `"handled"` after a notification.
  - Catch rejections from `Deps`.
- **REFACTOR:** Centralize the reason-to-notification mapping. Texts stay exact.
- **Verification:** Checks C-8 to C-15 give their GREEN result, and the gates pass.
- **Prerequisites:** none

### Task 4: List and stop forwards

- **Requirements:** FR-6, FR-8, F-9
- **Design references:** spec Functions `listForwards` and `stopForward`; Forward labels (validation); F-9
- **Entry point:** new `mods/port-forward/forward.js:listForwards` and `stopForward`
- **Allowed areas:** `mods/port-forward/forward.js`, `tests/port-forward/` (new `manage.test.mjs`; `fakes.mjs` may grow)
- **Depends on:** Task 0, Task 1
- **RED:**
  - Add `manage.test.mjs` with these tests:
    - `FR-6:` the exact `Forward[]` for `t9`; `[]` when no terminals exist; a terminal with a non-integer port label is ignored.
    - `FR-8:` `kill t9`, then `rm t9`, then `{ok: true}`.
    - `F-9:` `{ok: false, reason: "no such terminal"}` and no `rm`.
  - C-16 to C-18 give their RED result with `port-forward core missing: listForwards` or `stopForward`.
- **GREEN:** Implement both functions per the spec. Sort the list by `localPort`.
- **REFACTOR:** Reuse Task 2's label parser.
- **Verification:** Checks C-16, C-17 and C-18 give their GREEN result, and the gates pass.
- **Prerequisites:** none

### Task 5: Parse the dialog form into a forward request

- **Requirements:** FR-7, F-8
- **Design references:** spec Functions `parseForwardForm`; Models `ForwardRequest`; F-8; FR-7 verification (the `ensureForward` argv for local 5432)
- **Entry point:** new `mods/port-forward/forward.js:parseForwardForm`
- **Allowed areas:** `mods/port-forward/forward.js`, `tests/port-forward/` (new `form.test.mjs`)
- **Depends on:** Task 0, Task 1
- **RED:**
  - Add `form.test.mjs` with these tests:
    - `FR-7:` the default local port; `ensureForward` gives the contract argv for 5432; `"abc"` gives the remote-port error.
    - `F-8:` the three exact error texts.
  - C-19 and C-20 give their RED result with `port-forward core missing: parseForwardForm`.
- **GREEN:** Implement `parseForwardForm` with integer and range validation and `remoteHost: "localhost"`.
- **REFACTOR:** Share port validation with `forwardTarget`.
- **Verification:** Checks C-19 and C-20 give their GREEN result, and the gates pass.
- **Prerequisites:** none

### Task 6: Herdr routes loopback URL clicks to the mod

- **Requirements:** FR-1 (wiring), DoD-1
- **Design references:** spec Components (`link.js`, `mod.json`, `layouts/herdr-factory.json`); Link rule; Functions `link.js`
- **Entry point:** new `mods/port-forward/link.js:handleLink`
- **Allowed areas:** `mods/port-forward/link.js`, `mods/port-forward/mod.json`, `mods/port-forward/jsconfig.json` (copied from another mod's `jsconfig.json`, as in every existing mod), and the root `link_handlers` of `layouts/herdr-factory.json`
- **Depends on:** Task 0, Task 3
- **TDD does not apply:** `link.js` only adapts `herdr` functions into `Deps` and cannot load in Node. Its behavior is covered by C-1 to C-15 through `handleClick`. Herdr's load check C-21 and the human check C-H1 verify the wiring.
- **Work:**
  - Add `mod.json` with `place: "none"`, `title: "Port forwards"` and the exact link rule.
  - Add `link.js`: `handleLink` builds `Deps` (`sleep` as `exec("sleep", [String(ms / 1000)])`, `now` as `Date.now`) and returns `handleClick`.
  - Change `link_handlers` to `["herdr-explorer", "port-forward"]`.
- **Verification:**
  - C-21 gives RED before the change (`check failed: mods/port-forward`) and GREEN after.
  - The gates pass.
  - C-H1 gives its GREEN result when a reachable SSH machine exists. Otherwise it is recorded as unexecuted.
- **Prerequisites:** For C-H1: `./install.sh` has linked `mods/port-forward` into `~/.config/herdr-app/mods` (this changes the user's Herdr home, so ask the user before running it), the `herdr-factory` layout is shown, and a reachable SSH machine is available.

### Task 7: The "Port forwards" dialog adds, lists and stops forwards

- **Requirements:** FR-5, FR-6, FR-7, FR-8, DoD-2
- **Design references:** spec UI-1; Dialog add and stop; Functions `main.js`; Components `mod.json`
- **Entry point:** new `mods/port-forward/main.js` (default-exported `View`)
- **Allowed areas:** `mods/port-forward/main.js`, `mods/port-forward/mod.json`
- **Depends on:** Task 0, Task 4, Task 5, Task 6
- **TDD does not apply:** Herdr's view runtime cannot run in Node, and the repository has no UI test facility. The view's logic lives in the unit-tested core (C-16 to C-20). C-22 checks that the view loads and renders, and C-H2 verifies the dialog end to end.
- **Work:**
  - Add the view per UI-1: states, inputs, theme colors, focus in Remote port, Enter submits.
  - In `init`, return before starting processes when `checking()` is true.
  - Add to `mod.json` the palette entry `{"title": "Port forwards", "command": "mod.open", "args": {"name": "port-forward"}, "words": "ssh tunnel ports"}` and `"overlay": {"kind": "dialog", "width": 520, "height": 420}`.
- **Verification:**
  - C-22 gives RED before the change and GREEN after.
  - C-21 still passes, and the gates pass.
  - C-H2 gives its GREEN result when a reachable SSH machine exists. Otherwise it is recorded as unexecuted.
- **Prerequisites:** For C-H2: the same as Task 6.

### Task 8: README documents the mod

- **Requirements:** repository constraint: `README.md` lists every mod in Contents and their setup needs (spec Components `README.md`); FR-5 (how to open the dialog).
- **Design references:** spec Components; Constraints and Assumptions; Excluded and Deferred Requirements
- **Entry point:** `README.md`
- **Allowed areas:** `README.md`
- **Depends on:** Task 0, Task 7
- **TDD does not apply:** this is documentation only.
- **Work:**
  - Add a Contents row for `mods/port-forward/`.
  - Describe the Ctrl+click behavior and the "Port forwards" palette dialog.
  - List the prerequisites: an SSH machine with key or agent auth and a known host key; Linux `ss` and `xdg-open`.
  - Add Known gaps: no auto-detection, no `--via` machines, forwards outlive the window, no restart after drops.
- **Verification:** C-23 gives RED before the change and GREEN after, and the gates pass.
- **Prerequisites:** none

## Coverage

- **DoD-1** → C-H1 in Task 6
- **DoD-2** → C-H2 in Task 7
- **DoD-3** → C-4 in Task 1
- **FR-1** → C-1 in Task 1; C-21 in Task 6
- **FR-2** → C-6 in Task 2
- **FR-3** → C-4 in Task 1
- **FR-4** → C-8 in Task 3
- **FR-5** → C-22 in Task 7; C-23 in Task 8; C-H2 in Task 7
- **FR-6** → C-16 in Task 4
- **FR-7** → C-19 in Task 5
- **FR-8** → C-17 in Task 4
- **NFR-1** → C-2 in Task 1 (its `ss` part in C-H1)
- **NFR-2** → C-3 in Task 1
- **NFR-3** → C-12 in Task 3
- **F-1** → C-9; **F-2** → C-10; **F-3** → C-11; **F-4** → C-8; **F-5** → C-13; **F-7** → C-14; **F-11** → C-15 (all in Task 3)
- **F-6** → C-7 in Task 2
- **F-8** → C-20 in Task 5
- **F-9** → C-18 in Task 4
- **F-10** → C-5 in Task 1

## Final Verification

- **Run:** every check in the Checks block and every gate on the integrated result. C-H1 and C-H2 need a reachable SSH machine and the user's clicks; record them as unexecuted when it is unavailable.
- **Definition of done:**

| DoD | Type | Checks | Done when |
|---|---|---|---|
| DoD-1 | human | C-H1 | The capture succeeds and the user approves the evidence. |
| DoD-2 | human | C-H2 | The capture succeeds and the user approves the evidence. |
| DoD-3 | checkable | C-4 | All listed checks give their GREEN result. |
