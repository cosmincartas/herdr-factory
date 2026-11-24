// Task 2 checks: a repeated or concurrent click reuses the live forward for the
// same machine, remote host and port instead of starting a second ssh.

import assert from "node:assert/strict";
import test from "node:test";
import { forwardLabels, loadCore, makeFakeDeps, runCalls, sshMachine, urlClick } from "./fakes.mjs";

test("FR-2: a repeated click reuses the live forward", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    terminals: [{ address: "t9", labels: forwardLabels({ machine: "framework", local: 5173 }) }],
    listening: [5173],
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.equal(runCalls(calls).length, 0);
  assert.deepEqual(
    calls.exec.filter((call) => call.command === "xdg-open").map((call) => call.args),
    [["http://localhost:5173/app"]],
  );
});

test("F-6: a concurrent start that took the name is reused", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    terminals: [
      {
        address: "t9",
        appearsAfter: "run-attempt",
        labels: forwardLabels({ machine: "framework", local: 5173 }),
      },
    ],
    listenAfterPolls: 2,
    run: { code: 1, stderr: "name port-forward-5173 is already used by t9" },
  });

  const result = await ensureForward(
    { machine: "framework", remoteHost: "localhost", remotePort: 5173, localPort: 5173 },
    deps,
  );

  assert.deepEqual(result, {
    ok: true,
    reused: true,
    forward: { address: "t9", machine: "framework", localPort: 5173, remoteHost: "localhost", remotePort: 5173 },
  });
  assert.equal(runCalls(calls).length, 1);
});

test("R-02: a matching forward is reused only after it listens", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    terminals: [{ address: "t9", labels: forwardLabels({ machine: "framework", local: 5173 }) }],
    listenAfterPolls: 3,
  });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.equal(runCalls(calls).length, 0);
  assert.deepEqual(calls.sleep, [250, 250, 250]);
  assert.deepEqual(
    calls.exec.filter((call) => call.command === "xdg-open").map((call) => call.args),
    [["http://localhost:5173/app"]],
  );
});

test("R-02: a joining click never kills the owner's forward", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls, terminals, clock } = makeFakeDeps({
    machines: [sshMachine],
    terminals: [{ address: "t9", labels: forwardLabels({ machine: "framework", local: 5173 }) }],
  });

  const result = await ensureForward(
    { machine: "framework", remoteHost: "localhost", remotePort: 5173, localPort: 5173 },
    deps,
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "ssh did not start listening on port 5173 within 20 s",
  });
  assert.equal(calls.hc.some((args) => args[0] === "kill" || args[0] === "rm"), false);
  assert.equal(terminals.has("t9"), true);
  assert.ok(clock.now <= 20_250, `gave up after ${clock.now} simulated ms`);
});

test("R-02: a busy port is rechecked for an owned forward before F-3", async () => {
  const ensureForward = await loadCore("ensureForward");
  const { deps, calls } = makeFakeDeps({
    machines: [sshMachine],
    listening: [5173],
    terminals: [
      {
        address: "t9",
        appearsAfter: "ss-check",
        labels: forwardLabels({ machine: "framework", local: 5173 }),
      },
    ],
  });

  const result = await ensureForward(
    { machine: "framework", remoteHost: "localhost", remotePort: 5173, localPort: 5173 },
    deps,
  );

  assert.deepEqual(result, {
    ok: true,
    reused: true,
    forward: { address: "t9", machine: "framework", localPort: 5173, remoteHost: "localhost", remotePort: 5173 },
  });
  assert.equal(runCalls(calls).length, 0);
  assert.equal(calls.hc.some((args) => args[0] === "kill" || args[0] === "rm"), false);
});
