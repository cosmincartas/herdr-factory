// Opens while a press is held: herdr-core delivers `hc keys` only after ~3 s with no person input
// in that terminal, so opens made meanwhile must not stack up F12 presses (each extra one makes
// Helix run `herdr-explorer take` with nothing queued). They replace the queued path instead,
// and the press already waiting opens the newest file, once.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { calls, reset, state } from "herdr";
import { Router, OPEN_KEY } from "../router.js";

const TAB = "tab1", HX = "t1", RUNTIME = "/run/herdr-explorer", QUEUED = `${RUNTIME}/${HX}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A Helix pane in TAB whose F12 takes the queued file, and an `hc keys` that herdr-core holds
 *  until release() (all held presses then arrive in order, as the core delivers them). */
function helix() {
  const files = new Map(), opened = [], held = [];
  let holding = true;
  state.focused = () => ({ space: "s", tab: TAB, pane: "p0", terminal: null, shown: null, agent: null, cwd: null });
  state.panes = () => [{ pane: "p1", terminal: HX, tab: TAB, program: { key: "hx" } }];
  state.readTextFile = path => files.get(path) ?? null;
  state.writeTextFile = (path, text, expected) => {
    if ((files.get(path) ?? null) !== expected) throw new Error("stale");
    files.set(path, text);
    return null;
  };
  const deliver = keys => { for (const key of keys) if (key === OPEN_KEY) {
    const path = files.get(QUEUED);
    files.delete(QUEUED);
    opened.push(path ?? "nothing queued");
  } };
  state.hc = args => {
    const keys = args.slice(2);
    if (!holding) { deliver(keys); return { code: 0, stdout: "", stderr: "" }; }
    return new Promise(resolve => held.push(() => { deliver(keys); resolve({ code: 0, stdout: "", stderr: "" }); }));
  };
  const release = () => { holding = false; for (const go of held.splice(0)) go(); };
  return { files, opened, release, presses: () => calls.hc.length };
}

const router = () => { const r = new Router(); r.runtime = RUNTIME; return r; };

beforeEach(() => { reset(); localStorage.clear(); });

test("opens made while the press is held press once, and Helix opens the newest file", async () => {
  const h = helix(), r = router();
  const opens = ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"].map(path => r.open(path, { sleep }));
  await sleep(20);
  assert.equal(h.presses(), 1, "only the first open presses while herdr-core holds the key");
  assert.equal(h.files.get(QUEUED), "/repo/c.ts", "the queued path is the newest one");
  h.release();
  const sent = await Promise.all(opens);
  assert.deepEqual(h.opened, ["/repo/c.ts"], "Helix took one path: the newest, with no empty takes");
  assert.equal(h.presses(), 1);
  for (const s of sent) assert.equal(s.terminal, HX);
});

test("a path queued just after Helix took the last one is still opened", async () => {
  const h = helix(), r = router();
  const first = r.open("/repo/a.ts", { sleep });
  await sleep(20);
  h.release();  // Helix takes a.ts; the press is answered
  const second = r.open("/repo/b.ts", { sleep });
  await Promise.all([first, second]);
  assert.deepEqual(h.opened, ["/repo/a.ts", "/repo/b.ts"]);
  assert.equal(h.files.has(QUEUED), false, "nothing left queued");
});

test("with the key not held, each open presses once", async () => {
  const h = helix(), r = router();
  h.release();
  await r.open("/repo/a.ts", { sleep });
  await r.open("/repo/b.ts", { sleep });
  assert.deepEqual(h.opened, ["/repo/a.ts", "/repo/b.ts"]);
  assert.equal(h.presses(), 2);
});

test("a Ctrl+click Router (no sleep) still presses Esc and F12 itself", async () => {
  const h = helix();
  h.release();
  await router().open("/repo/a.ts");
  assert.deepEqual(calls.hc.map(c => c.args.slice(2)), [["esc", OPEN_KEY]]);
  assert.deepEqual(h.opened, ["/repo/a.ts"]);
});
