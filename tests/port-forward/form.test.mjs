// Task 5 checks: the dialog's form becomes a ForwardRequest (spec "Models"),
// and the request starts the Forward start command of the specification.

import assert from "node:assert/strict";
import test from "node:test";
import { loadCore, makeFakeDeps, runCalls, sshMachine } from "./fakes.mjs";

// The Forward start command of the specification for local 5432.
const START_ARGV = [
  "run", "--bg", "--json", "--no-parent", "--name", "port-forward-5432",
  "--label", "port-forward=1",
  "--label", "port-forward.machine=framework",
  "--label", "port-forward.local=5432",
  "--label", "port-forward.host=localhost",
  "--label", "port-forward.remote=5432",
  "--", "ssh", "-N",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-L", "localhost:5432:localhost:5432",
  "cosmincartas@framework",
];

test("FR-7: a blank local port defaults to the remote port", async () => {
  const parseForwardForm = await loadCore("parseForwardForm");
  const ensureForward = await loadCore("ensureForward");

  const parsed = parseForwardForm({ machine: "framework", remotePort: "5432", localPort: "" });

  assert.deepEqual(parsed, {
    ok: true,
    request: { machine: "framework", remoteHost: "localhost", remotePort: 5432, localPort: 5432 },
  });

  // The parsed request starts the specification's forward command for local 5432.
  const { deps, calls } = makeFakeDeps({ machines: [sshMachine], listenAfterRun: true });
  const result = await ensureForward(parsed.request, deps);

  assert.equal(result.ok, true);
  assert.deepEqual(runCalls(calls), [START_ARGV]);

  assert.deepEqual(parseForwardForm({ machine: "framework", remotePort: "abc", localPort: "" }), {
    ok: false,
    error: "Remote port must be a number from 1 to 65535",
  });
});

test("F-8: invalid form input gets the exact error texts", async () => {
  const parseForwardForm = await loadCore("parseForwardForm");

  const cases = [
    [{ machine: "", remotePort: "80" }, "Choose a machine"],
    [{ remotePort: "0" }, "Remote port must be a number from 1 to 65535"],
    [{ remotePort: "80", localPort: "70000" }, "Local port must be a number from 1 to 65535"],
  ];

  for (const [form, error] of cases) {
    assert.deepEqual(parseForwardForm(form), { ok: false, error }, JSON.stringify(form));
  }
});
