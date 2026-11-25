// C-13: `herdr-explorer find|search` leaves the request for the mod instead of sleeping.
//
// bin/herdr-explorer runs as a real child process, against a fake herdr-app that comes first on
// PATH (the real one is never called) and a temp XDG_RUNTIME_DIR. The fake records every call and
// whether the request file was already there, so the test can see the panel selected and shown,
// the request left for the mod, and one wake after it. Today the CLI sleeps 0.3 s for a panel that
// has to start its mod; the request removes the wait.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { reset as resetHerdr, state as herdrState } from "herdr";
import Explorer from "../main.js";
import { createCx, flush } from "./stubs/cx.mjs";

const CLI = fileURLToPath(new URL("../bin/herdr-explorer", import.meta.url));

let work, fakeBin, log;

before(async () => {
  work = await mkdtemp(join(tmpdir(), "herdr-explorer-cli."));
  fakeBin = join(work, "bin");
  log = join(work, "herdr-app.log");
  await mkdir(fakeBin);
  // Records the arguments and whether the CLI had already left the request, then succeeds.
  await writeFile(join(fakeBin, "herdr-app"),
    '#!/bin/sh\nprintf \'%s\\t%s\\n\' "$*" "$([ -f "${XDG_RUNTIME_DIR:-/tmp}/herdr-explorer/command" ] && echo yes || echo no)" >> "$FAKE_HERDR_APP_LOG"\nexit 0\n');
  await chmod(join(fakeBin, "herdr-app"), 0o755);
  // Only when FAKE_MV_LOCK is set: the first rename waits for the second one, so two concurrent
  // invocations overlap their temporary file and rename (which a shared temp path cannot survive).
  await writeFile(join(fakeBin, "mv"),
    '#!/bin/sh\nif [ -n "${FAKE_MV_LOCK:-}" ]; then\n'
    + '  if mkdir "$FAKE_MV_LOCK" 2>/dev/null; then\n'
    + '    i=0\n'
    + '    while [ ! -e "$FAKE_MV_LOCK/go" ]; do sleep 0.01; i=$((i+1)); [ "$i" -gt 500 ] && break; done\n'
    + '  else\n'
    + '    : > "$FAKE_MV_LOCK/go"\n'
    + '  fi\n'
    + 'fi\n'
    + 'exec /usr/bin/mv "$@"\n');
  await chmod(join(fakeBin, "mv"), 0o755);
});

after(async () => { await rm(work, { recursive: true, force: true }); });

/** A fresh runtime folder and an environment whose PATH holds only the fake herdr-app. */
async function environment() {
  const runtime = await mkdtemp(join(work, "runtime."));
  await writeFile(log, "");
  return {
    runtime,
    env: { PATH: `${fakeBin}:/usr/bin:/bin`, HOME: work, XDG_RUNTIME_DIR: runtime, FAKE_HERDR_APP_LOG: log },
  };
}

/** Runs the CLI with `args`, returning its result and how long the whole call took. */
function cli(args, env) {
  const started = process.hrtime.bigint();
  const result = spawnSync(CLI, args, { encoding: "utf8", env });
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

/** Starts the CLI and waits for it, for a test that runs two at once. */
function cliAsync(args, env) {
  return new Promise(resolve => {
    const child = spawn(CLI, args, { env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => resolve({ status: null, stderr: String(error) }));
    child.on("close", status => resolve({ status, stderr }));
  });
}

/** The request the CLI left in the runtime folder: { command, present, text, at }.
 *  Framing: command, whether a text argument was given, the timestamp, then the text (so a tab
 *  in the text is not read as the timestamp). */
async function request(runtime) {
  const dir = join(runtime, "herdr-explorer");
  const names = await readdir(dir);
  assert.deepEqual(names, ["command"], `runtime folder holds ${names.join(", ")} (temp file left behind?)`);
  const text = await readFile(join(dir, "command"), "utf8");
  assert.ok(text.endsWith("\n"), "the request ends with a newline");
  const [command, present, stamp, ...rest] = text.replace(/\n$/, "").split("\t");
  return { command, present: present === "1", at: Number(stamp), text: rest.join("\t") };
}

/** Every herdr-app call, in order: { call, request } whether the request file was there yet. */
async function appCalls() {
  const text = await readFile(log, "utf8");
  return text.split("\n").filter(Boolean).map(line => {
    const [call, request] = line.split("\t");
    return { call, request: request === "yes" };
  });
}

test("herdr-explorer find: returns at once, leaving the request for the mod", async () => {
  const { runtime, env } = await environment();
  const { result, ms } = cli(["find", "foo"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(ms < 150, `herdr-explorer find took ${ms.toFixed(1)} ms (300 ms or more while it slept for the panel)`);

  const pending = await request(runtime);
  assert.equal(pending.command, "find-files");
  assert.equal(pending.text, "foo");
  assert.equal(pending.present, true);
  assert.ok(Math.abs(Date.now() - pending.at) < 5000, `the request is stamped now, not ${pending.at}`);
});

test("herdr-explorer find: publishes the request before it shows the panel", async () => {
  const { env } = await environment();
  assert.equal(cli(["find", "foo"], env).result.status, 0);

  const calls = await appCalls();
  assert.deepEqual(calls.map(c => c.call), [
    'do layout.select {"stack":"panel-body","child":"files"}',
    'do layout.show {"id":"panel"}',
    "do herdr-explorer.pending",
  ], "the panel is selected and shown, then the mod woken once (no command it may miss)");
  assert.ok(calls.every(c => c.request), "the request is on disk before the panel is shown, so its mod reads it at init");
});

test("herdr-explorer search: several words become the request's text", async () => {
  const { runtime, env } = await environment();
  const { result, ms } = cli(["search", "foo", "bar"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(ms < 150, `herdr-explorer search took ${ms.toFixed(1)} ms`);
  const pending = await request(runtime);
  assert.equal(pending.command, "search");
  assert.equal(pending.text, "foo bar");
});

test("herdr-explorer search: a tab in the text stays in the text", async () => {
  const { runtime, env } = await environment();
  assert.equal(cli(["search", "left\tright"], env).result.status, 0);
  const pending = await request(runtime);
  assert.equal(pending.command, "search");
  assert.equal(pending.text, "left\tright", "the timestamp is framed apart from the text");
  assert.ok(Math.abs(Date.now() - pending.at) < 5000, `the timestamp is its own field, not ${pending.at}`);
});

test("herdr-explorer find: no argument is absent, an explicit empty one is present", async () => {
  const omitted = await environment();
  assert.equal(cli(["find"], omitted.env).result.status, 0);
  const none = await request(omitted.runtime);
  assert.equal(none.command, "find-files");
  assert.equal(none.present, false, "no argument leaves the query alone");
  assert.equal(none.text, "");

  const empty = await environment();
  assert.equal(cli(["search", ""], empty.env).result.status, 0);
  const cleared = await request(empty.runtime);
  assert.equal(cleared.command, "search");
  assert.equal(cleared.present, true, "an explicit empty argument clears the query");
  assert.equal(cleared.text, "");
});

test("herdr-explorer find: concurrent invocations each publish their own request", async () => {
  const { runtime, env } = await environment();
  const shared = { ...env, FAKE_MV_LOCK: join(work, "mv-lock") };
  const [a, b] = await Promise.all([cliAsync(["find", "alpha"], shared), cliAsync(["find", "beta"], shared)]);

  assert.equal(a.status, 0, `one invocation failed while the other renamed its request: ${a.stderr}`);
  assert.equal(b.status, 0, `one invocation failed while the other renamed its request: ${b.stderr}`);
  const pending = await request(runtime);
  assert.equal(pending.command, "find-files");
  assert.ok(["alpha", "beta"].includes(pending.text), `one whole request, not another's bytes: ${JSON.stringify(pending.text)}`);
  const wakes = (await appCalls()).filter(c => c.call === "do herdr-explorer.pending");
  assert.equal(wakes.length, 2, "both invocations woke the mod");
});

test("herdr-explorer search: the mod applies the text the CLI left, tab and all", async () => {
  const { runtime, env } = await environment();
  assert.equal(cli(["search", "left\tright"], env).result.status, 0);

  resetHerdr();
  const dir = join(runtime, "herdr-explorer");
  herdrState.exec = () => ({ code: 0, stdout: dir, stderr: "" });
  herdrState.readTextFile = path => { try { return readFileSync(path, "utf8"); } catch { return null; } };
  const cx = createCx();
  const explorer = new Explorer();
  explorer.init(undefined, cx);
  await flush();

  assert.equal(explorer.runtime, dir);
  assert.equal(explorer.view, "search");
  assert.equal(explorer.searchInput.value(), "left\tright");
});
