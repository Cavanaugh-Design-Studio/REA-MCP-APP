#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { WindowsJobElectronActiveProvider } from "../dist/browser/WindowsJobElectronActiveProvider.js";

assert.equal(process.platform, "win32");
const executable = resolve(
  process.argv[2] ?? ".cache/electron-runtime-42.2.0/electron.exe",
);
const output = resolve(`.cache/electron-cleanup/${Date.now()}`);
const application = join(output, "application");
await mkdir(application, { recursive: true });
for (const file of await readdir("tests/conformance/readiness/electron"))
  await copyFile(
    join("tests/conformance/readiness/electron", file),
    join(application, file),
  );
await writeFile(
  join(application, "package.json"),
  JSON.stringify({ type: "commonjs", main: "main.js" }),
);
const source = await readFile(join(application, "main.js"), "utf8");
assert(source.includes("setTimeout(() => {}, 100)"));
await writeFile(
  join(application, "main.js"),
  source
    .replace("setTimeout(() => {}, 100)", "setTimeout(() => {}, 300000)")
    .replace('{ stdio: "ignore" }', '{ stdio: "ignore", detached: true }')
    .replace(
      'process.env.REA_ELECTRON_NODE_EXECUTABLE ?? "node"',
      JSON.stringify(process.execPath),
    ),
);
const provider = new WindowsJobElectronActiveProvider({
  ...process.env,
  REA_ELECTRON_NODE_EXECUTABLE: process.execPath,
});
const input = {
  executable_path: executable,
  application_path: join(application, "main.js"),
  application_root: application,
  actions: [
    { step_id: "settle", kind: "wait", duration_ms: 250, window_index: 0 },
  ],
};
const rows = [];
const save = async (name, result) => {
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify(result, null, 2),
  );
  rows.push({
    name,
    ok: result.ok,
    reason: result.error?.reason ?? null,
    cleanup:
      result.value?.application.cleanup ??
      result.error?.partialObservation?.capture?.application.cleanup ??
      null,
    cleanup_incomplete: result.error?.cleanupIncomplete ?? false,
  });
};
const normal = await provider.capture(input, {
  signal: AbortSignal.timeout(45000),
});
await save("detached-helper", normal);
assert(normal.ok, normal.error?.message);
assert.equal(normal.value.application.cleanup, "terminated-owned-process");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 3000);
let cancelled;
try {
  cancelled = await provider.capture(
    {
      ...input,
      actions: [
        { step_id: "wait", kind: "wait", duration_ms: 30000, window_index: 0 },
      ],
    },
    { signal: controller.signal },
  );
} finally {
  clearTimeout(timer);
}
await save("cancelled", cancelled);
assert.equal(cancelled.ok, false);
assert.equal(cancelled.error.reason, "cancelled");
assert.equal(cancelled.error.cleanupIncomplete, false);
const failed = await provider.capture(
  { ...input, executable_path: join(output, "missing-electron.exe") },
  { signal: AbortSignal.timeout(15000) },
);
await save("startup-failure", failed);
assert.equal(failed.ok, false);
assert.equal(failed.error.cleanupIncomplete, false);
const report = {
  output,
  scope:
    "Real Windows Electron: retained native Job Object cleanup of a detached five-minute helper, cancellation and failed startup. Public MCP normal capture is reported separately.",
  cases: rows,
  passed: true,
};
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report) + "\n");
