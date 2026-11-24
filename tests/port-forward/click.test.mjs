// Task 1 checks: a Ctrl+click on a loopback URL printed by a program on a remote
// SSH machine starts a loopback-only, non-interactive forward and opens it.
// A URL that is not strictly loopback is left to Herdr.

import assert from "node:assert/strict";
import test from "node:test";
import { loadCore, makeFakeDeps, runCalls, sshArgvOf, sshMachine, urlClick } from "./fakes.mjs";

// The Forward start command of the specification, verbatim.
const START_ARGV = [
  "run", "--bg", "--json", "--no-parent", "--name", "port-forward-5173",
  "--label", "port-forward=1",
  "--label", "port-forward.machine=framework",
  "--label", "port-forward.local=5173",
  "--label", "port-forward.host=localhost",
  "--label", "port-forward.remote=5173",
  "--", "ssh", "-N",
  "-o", "BatchMode=yes",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-L", "localhost:5173:localhost:5173",
  "cosmincartas@framework",
];

/** The ssh argv of every forward built by one click per URL. */
async function builtSshArgvs(urls) {
  const handleClick = await loadCore("handleClick");
  const argvs = [];
  for (const url of urls) {
    const { deps, calls } = makeFakeDeps({ machines: [sshMachine], listenAfterRun: true });
    const result = await handleClick({ link: { kind: "url", url }, source: { machine: "framework" } }, deps);
    assert.equal(result, "handled", url);
    for (const run of runCalls(calls)) argvs.push(sshArgvOf(run));
  }
  return argvs;
}

const TWO_CLICKS = ["http://localhost:5173/app", "http://0.0.0.0:8080/"];

test("FR-1: forwards and opens a remote localhost URL", async () => {
  const handleClick = await loadCore("handleClick");
  const { deps, calls } = makeFakeDeps({ machines: [sshMachine], listenAfterRun: true });

  const result = await handleClick(urlClick(5173), deps);

  assert.equal(result, "handled");
  assert.deepEqual(runCalls(calls), [START_ARGV]);
  const opened = calls.exec.filter((call) => call.command === "xdg-open").map((call) => call.args);
  assert.deepEqual(opened, [["http://localhost:5173/app"]]);
});

test("NFR-1: every forward listens on localhost only", async () => {
  const argvs = await builtSshArgvs(TWO_CLICKS);

  assert.ok(argvs.length >= TWO_CLICKS.length, `built ${argvs.length} forwards`);
  for (const argv of argvs) {
    const at = argv.indexOf("-L");
    assert.ok(at >= 0, `no -L in ${argv.join(" ")}`);
    assert.ok(argv[at + 1].startsWith("localhost:"), `not loopback: ${argv[at + 1]}`);
  }
});

test("NFR-2: every forward runs ssh in batch mode", async () => {
  const argvs = await builtSshArgvs(TWO_CLICKS);

  assert.ok(argvs.length >= TWO_CLICKS.length, `built ${argvs.length} forwards`);
  for (const argv of argvs) {
    const batch = argv.some((item, at) => item === "-o" && argv[at + 1] === "BatchMode=yes");
    assert.ok(batch, `no BatchMode=yes in ${argv.join(" ")}`);
  }
});

test("F-10: a URL that is not strictly loopback gets no forward", async () => {
  const forwardTarget = await loadCore("forwardTarget");

  for (const url of [
    "http://localhost:99999/",
    "http://localhost/",
    "http://localhost.evil.com:80/",
    "ftp://localhost:21/",
  ]) {
    assert.equal(forwardTarget(url), null, url);
  }
});
