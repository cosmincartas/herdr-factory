// Task 3 checks: a forward that cannot be established notifies with the reason,
// never opens the browser, and leaves no forward terminal behind.

import assert from "node:assert/strict";
import test from "node:test";
import { forwardLabels, loadCore, makeFakeDeps, runCalls, sshMachine, urlClick } from "./fakes.mjs";

const REQUEST = { machine: "framework", remoteHost: "localhost", remotePort: 5173, localPort: 5173 };

test("FR-4: an ssh that ends before listening notifies its last line", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls, terminals } = makeFakeDeps({
    machines: [sshMachine],
    started: { state: "exited", output: "Warning: Permanently added 'framework'.\ncosmincartas@framework: Permission denied (publickey).\n" },
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    {
      level: "error",
      title: "Couldn't forward port 5173",
      body: "cosmincartas@framework: Permission denied (publickey).",
    },
  ]);
  assert.ok(calls.hc.some((args) => args[0] === "rm" && args[1] === "t9"), "no hc rm t9");
  assert.equal(calls.exec.filter((call) => call.command === "xdg-open").length, 0);
  assert.equal(terminals.has("t9"), false);
});

test("F-1: a machine that is not an SSH machine notifies and starts nothing", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({ machines: [{ name: "fly", target: "", via: true, state: "ready" }] });

  const result = await handleClick(urlClick(5173, { machine: "fly" }), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    {
      level: "error",
      title: "Couldn't forward port 5173",
      body: "fly isn't an SSH machine, so its ports can't be forwarded",
    },
  ]);
  assert.equal(runCalls(calls).length, 0);
});

test("F-2: a local port that forwards elsewhere is not taken over", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    terminals: [{ address: "t9", labels: forwardLabels({ machine: "vps", local: 5173 }) }],
  });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, { ok: false, reason: "Local port 5173 already forwards to vps:localhost:5173" });
  assert.equal(runCalls(calls).length, 0);
});

test("F-3: a local port another process listens on is not forwarded onto", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls } = makeFakeDeps({ machines: [sshMachine], listening: [5173] });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, { ok: false, reason: "Local port 5173 is already in use on this computer" });
  assert.equal(runCalls(calls).length, 0);
});

test("NFR-3: a click resolves within Herdr's 30 s link-handler limit", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls, clock } = makeFakeDeps({ machines: [sshMachine] });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.ok(clock.now <= 20_250, `the click resolved after ${clock.now} simulated ms`);
  assert.deepEqual(calls.notify.map((notification) => notification.title), ["Couldn't forward port 5173"]);
});

test("F-5: a forward that never listens is killed and removed at the deadline", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls, clock } = makeFakeDeps({ machines: [sshMachine] });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "ssh did not start listening on port 5173 within 20 s",
  });
  const kill = calls.hc.findIndex((args) => args[0] === "kill" && args[1] === "t9");
  const rm = calls.hc.findIndex((args) => args[0] === "rm" && args[1] === "t9");
  assert.ok(kill >= 0, "no hc kill t9");
  assert.ok(rm > kill, "hc rm t9 does not follow hc kill t9");
  assert.ok(clock.now <= 20_250, `gave up after ${clock.now} simulated ms`);
});

test("F-7: a failed browser opener notifies and keeps the forward", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls, terminals } = makeFakeDeps({
    machines: [sshMachine],
    listenAfterRun: true,
    open: { code: 3, stderr: "no browser" },
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    {
      level: "error",
      title: "Couldn't open http://localhost:5173/app",
      body: "The forward is ready, but xdg-open failed: no browser",
    },
  ]);
  assert.equal(calls.hc.filter((args) => args[0] === "kill").length, 0);
  assert.equal(terminals.has("t9"), true);
});

test("F-11: a failed hc run notifies its reason and opens nothing", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    run: { code: 1, stderr: "core not running" },
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    { level: "error", title: "Couldn't forward port 5173", body: "core not running" },
  ]);
  assert.equal(calls.exec.filter((call) => call.command === "xdg-open").length, 0);
});

test("R-04: a listener found after the readiness deadline is not accepted", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls, clock } = makeFakeDeps({
    machines: [sshMachine],
    listenAtMs: 20_000,
    ssLatencyMs: 1_500,
  });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "ssh did not start listening on port 5173 within 20 s",
  });
  assert.ok(clock.now > 20_000, `accepted a slow poll at ${clock.now} simulated ms`);
  const kill = calls.hc.findIndex((args) => args[0] === "kill" && args[1] === "t9");
  const rm = calls.hc.findIndex((args) => args[0] === "rm" && args[1] === "t9");
  assert.ok(kill >= 0, "no hc kill t9");
  assert.ok(rm > kill, "hc rm t9 does not follow hc kill t9");
});

test("R-04: xdg-open is bounded by the Deps exec timeout", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls, clock } = makeFakeDeps({ machines: [sshMachine], listenAfterRun: true });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  const opened = calls.exec.find((call) => call.command === "xdg-open");
  assert.ok(opened, "xdg-open was not run");
  assert.equal(typeof opened.options?.timeout, "number", "xdg-open has no timeout");
  assert.ok(opened.options.timeout > 0 && opened.options.timeout <= 10_000, `timeout ${opened.options.timeout}`);
  assert.ok(clock.now < 30_000, `the click took ${clock.now} simulated ms`);
});

test("R-05: an inspection error after start is not an ssh exit and is cleaned up", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls, terminals } = makeFakeDeps({
    machines: [sshMachine],
    get: { code: 1, stderr: "core hiccup" },
  });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, { ok: false, reason: "core hiccup" });
  const kill = calls.hc.findIndex((args) => args[0] === "kill" && args[1] === "t9");
  const rm = calls.hc.findIndex((args) => args[0] === "rm" && args[1] === "t9");
  assert.ok(kill >= 0, "no hc kill t9");
  assert.ok(rm > kill, "hc rm t9 does not follow hc kill t9");
  assert.equal(terminals.has("t9"), false);
});

test("R-05: a failed cleanup keeps the original failure reason and reports it", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    get: { code: 1, stderr: "core hiccup" },
    kill: { code: 1, stderr: "kill denied" },
    rm: { code: 1, stderr: "rm denied" },
  });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "core hiccup",
    cleanupError: "kill denied; rm denied",
  });
  const kill = calls.hc.findIndex((args) => args[0] === "kill" && args[1] === "t9");
  const rm = calls.hc.findIndex((args) => args[0] === "rm" && args[1] === "t9");
  assert.ok(kill >= 0, "no hc kill t9");
  assert.ok(rm > kill, "cleanup did not check removal after a failed kill");
});

test("R-06: a --via machine on a busy port reports F-1 before F-3", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({
    machines: [{ name: "fly", target: "", via: true, state: "ready" }],
    listening: [5173],
  });

  const result = await handleClick(urlClick(5173, { machine: "fly" }), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    {
      level: "error",
      title: "Couldn't forward port 5173",
      body: "fly isn't an SSH machine, so its ports can't be forwarded",
    },
  ]);
  assert.equal(runCalls(calls).length, 0);
});

test("R-06: a machine lookup error is reported instead of F-1", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({ machineLs: { code: 1, stderr: "core unavailable" } });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    { level: "error", title: "Couldn't forward port 5173", body: "core unavailable" },
  ]);
  assert.equal(runCalls(calls).length, 0);
});

test("R-06: a failed initial forward scan starts nothing", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    lsFailure: { code: 1, stderr: "listing failed" },
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(calls.notify, [
    { level: "error", title: "Couldn't forward port 5173", body: "listing failed" },
  ]);
  assert.equal(runCalls(calls).length, 0);
});

test("R-06: a failed collision recheck keeps the original hc run error", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps } = makeFakeDeps({
    machines: [sshMachine],
    run: { code: 1, stderr: "run refused" },
    lsFailureAfterRun: { code: 1, stderr: "recheck failed" },
  });

  const result = await ensureForward(REQUEST, deps);

  assert.deepEqual(result, { ok: false, reason: "run refused" });
});
