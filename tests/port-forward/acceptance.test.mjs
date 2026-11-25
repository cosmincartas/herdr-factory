// Acceptance checks that the spec calls DoD-3.
//
// The loader below is intentionally local to this file: Task 0 owns this check,
// and it must fail by naming the missing core rather than by failing an import.
// The fakes are local for the same reason; later tasks may add a shared
// tests/port-forward/fakes.mjs without changing this acceptance check.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const CORE_PATH = fileURLToPath(new URL("../../mods/port-forward/forward.js", import.meta.url));

/** Load one required export, or say which piece of the core is missing. */
async function loadCore(exportName) {
  if (!existsSync(CORE_PATH)) throw new Error(`port-forward core missing: ${exportName}`);
  const core = await import(pathToFileURL(CORE_PATH).href);
  if (typeof core[exportName] !== "function") {
    throw new Error(`port-forward core missing: ${exportName}`);
  }
  return core[exportName];
}

/** A Deps fake that records every call instead of running anything. */
function makeFakeDeps() {
  const calls = { hc: [], exec: [], notify: [], sleep: [], now: 0 };
  return {
    calls,
    deps: {
      hc: async (args) => {
        calls.hc.push(args);
        return { code: 0, stdout: "{}", stderr: "" };
      },
      exec: async (command, args, options) => {
        calls.exec.push({ command, args, options });
        return { code: 0, stdout: "", stderr: "" };
      },
      notify: (notification) => {
        calls.notify.push(notification);
      },
      sleep: async (ms) => {
        calls.sleep.push(ms);
      },
      now: () => calls.now,
    },
  };
}

test("DoD-3: a loopback URL click in a local terminal keeps Herdr's behavior", async () => {
  const handleClick = await loadCore("handleClick");
  const { calls, deps } = makeFakeDeps();

  const result = await handleClick(
    {
      link: { kind: "url", url: "http://localhost:3000/" },
      source: { machine: null },
    },
    deps,
  );

  assert.equal(result, "pass");
  assert.deepEqual(calls.hc, []);
  assert.deepEqual(calls.exec, []);
});
