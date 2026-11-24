// Task 4 checks: the dialog's list of live forwards, and stopping one.
// Both read and act on herdr-core labels (spec "Forward labels").

import assert from "node:assert/strict";
import test from "node:test";
import { forwardLabels, loadCore, makeFakeDeps, runCalls, sshMachine } from "./fakes.mjs";

/** A live forward terminal for one local port, labeled as the core labels them. */
const forwardTerminal = (address, localPort) => ({
  address,
  labels: forwardLabels({ machine: "framework", local: localPort, remote: localPort }),
});

test("FR-6: lists every live forward with its machine and ports", async () => {
  const listForwards = await loadCore("listForwards");

  // FR-6's own scenario: t9 forwards local 15432 to framework's localhost:5432.
  const single = makeFakeDeps({
    terminals: [
      {
        address: "t9",
        labels: forwardLabels({ machine: "framework", local: 15432, host: "localhost", remote: 5432 }),
      },
    ],
  });

  assert.deepEqual(await listForwards(single.deps), [
    { address: "t9", machine: "framework", localPort: 15432, remoteHost: "localhost", remotePort: 5432 },
  ]);
  assert.ok(
    single.calls.hc.some((args) => args[0] === "ls" && args.includes("port-forward=1")),
    "hc ls is not filtered by the port-forward schema version",
  );

  // No forwards: the dialog shows "No port forwards".
  assert.deepEqual(await listForwards(makeFakeDeps().deps), []);

  // A terminal whose port label is not an integer is ignored (Forward labels validation).
  const badLabel = makeFakeDeps({
    terminals: [
      { address: "t8", labels: { ...forwardLabels({ local: 5173 }), "port-forward.local": "5173x" } },
    ],
  });
  assert.deepEqual(await listForwards(badLabel.deps), []);

  // Sorted by local port, whatever order herdr-core lists them in.
  const unordered = makeFakeDeps({ terminals: [forwardTerminal("t8", 15432), forwardTerminal("t9", 5173)] });
  assert.deepEqual(
    (await listForwards(unordered.deps)).map((forward) => forward.localPort),
    [5173, 15432],
  );
});

test("FR-8: stopping a forward kills and removes its terminal", async () => {
  const stopForward = await loadCore("stopForward");
  const { deps, calls, terminals } = makeFakeDeps({
    terminals: [forwardTerminal("t9", 5173)],
  });

  const result = await stopForward("t9", deps);

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.hc, [["kill", "t9"], ["rm", "t9"]]);
  assert.equal(terminals.has("t9"), false);
});

test("F-9: a stop whose kill fails reports why and removes nothing", async () => {
  const stopForward = await loadCore("stopForward");
  const { deps, calls } = makeFakeDeps({
    terminals: [forwardTerminal("t9", 5173)],
    kill: { code: 1, stderr: "no such terminal" },
  });

  const result = await stopForward("t9", deps);

  assert.deepEqual(result, { ok: false, reason: "no such terminal" });
  assert.equal(calls.hc.filter((args) => args[0] === "rm").length, 0);
});

test("R-01: forward scans ignore remote machine/tN addresses", async () => {
  const listForwards = await loadCore("listForwards");
  const ensureForward = await loadCore("ensureForward");

  const list = makeFakeDeps({
    terminals: [
      { address: "vps/t9", labels: forwardLabels({ machine: "framework", local: 5173 }) },
      { address: "t8", labels: forwardLabels({ machine: "framework", local: 15432, remote: 5432 }) },
    ],
  });
  assert.deepEqual((await listForwards(list.deps)).map((forward) => forward.address), ["t8"]);

  const reuse = makeFakeDeps({
    machines: [sshMachine],
    terminals: [{ address: "vps/t9", labels: forwardLabels({ machine: "framework", local: 5173 }) }],
    listenAfterRun: true,
  });
  const result = await ensureForward(
    { machine: "framework", remoteHost: "localhost", remotePort: 5173, localPort: 5173 },
    reuse.deps,
  );
  assert.equal(result.ok, true);
  assert.equal(result.reused, false, "a remote terminal was reused as a local forward");
  assert.equal(runCalls(reuse.calls).length, 1);
});

test("R-01: stopForward refuses a remote terminal address", async () => {
  const stopForward = await loadCore("stopForward");
  const { deps, calls, terminals } = makeFakeDeps({
    terminals: [{ address: "vps/t9", labels: forwardLabels({ local: 5173 }) }],
  });

  const result = await stopForward("vps/t9", deps);

  assert.equal(result.ok, false);
  assert.deepEqual(calls.hc, []);
  assert.equal(terminals.has("vps/t9"), true);
});

test("R-12: a kill with empty stderr uses the F-9 fallback", async () => {
  const stopForward = await loadCore("stopForward");
  const { deps, calls } = makeFakeDeps({
    terminals: [forwardTerminal("t9", 5173)],
    kill: { code: 1, stderr: "" },
  });

  const result = await stopForward("t9", deps);

  assert.deepEqual(result, { ok: false, reason: "hc kill failed" });
  assert.equal(calls.hc.filter((args) => args[0] === "rm").length, 0);
});
