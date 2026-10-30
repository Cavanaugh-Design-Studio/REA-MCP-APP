import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { LocalTools } from "../dist/localTools.js";
import { taskInputSchema } from "../dist/contracts.js";
import {
  appRoot,
  originalRoot,
  assertPinnedNode,
  acceptanceEnvironment,
} from "./acceptance-paths.mjs";

// One real archive comparison. No inference requests or spend-ledger access.
await assertPinnedNode();
const root = join(appRoot, ".cache/live-acceptance"),
  original = await originalRoot(process.argv[2]);
await mkdir(join(root, "source", ".webpack"), { recursive: true });
const source =
  "const {ipcMain}=require('electron');\nconst rows=['alpha','beta','gamma'];\nipcMain.handle('kestrel:lookup:v3',(_event,query)=>{if(typeof query!=='string') throw new TypeError('query must be a string');return rows.filter(row=>row.includes(query)).slice(0,12);});\n";
await writeFile(
  join(root, "source", "package.json"),
  JSON.stringify({
    name: "rea-acceptance-archive",
    version: "1.0.0",
    main: ".webpack/main.js",
  }),
);
await writeFile(join(root, "source", ".webpack", "main.js"), source);
const api = createRequire(join(original, "package.json")).resolve(
  "@electron/asar",
);
const asar = await import(pathToFileURL(api).href),
  target = join(root, "selected-app.asar");
await asar.createPackage(join(root, "source"), target);
const digest = async () =>
  createHash("sha256")
    .update(await readFile(target))
    .digest("hex");
const temporary = join(root, "tmp");
await mkdir(temporary, { recursive: true });
const environment = acceptanceEnvironment({
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
});
const before = await digest(),
  tools = new LocalTools(environment),
  id = "provider-" + Date.now(),
  signal = new AbortController().signal;
try {
  const workspace = await tools.prepare(
    id,
    taskInputSchema.parse({
      question: "Archive acceptance",
      target,
      workspace: join(root, "runs"),
    }),
    signal,
  );
  const code = `const a=await import(${JSON.stringify(pathToFileURL(api).href)});const t=process.argv[1];const p=JSON.parse(a.extractFile(t,'package.json').toString());console.log(JSON.stringify({files:a.listPackage(t),package:p,source:a.extractFile(t,p.main).toString()}));`;
  const result = await tools.execute(
    "run_command",
    {
      executable: process.execPath,
      arguments: ["--input-type=module", "-e", code, workspace.target],
      timeout_ms: 30000,
      max_output_bytes: 262144,
    },
    workspace,
    id,
    signal,
    [],
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  await writeFile(
    join(root, "local-provider-evidence.json"),
    JSON.stringify(result.value, null, 2),
  );
  const baseline = await promisify(execFile)(
    process.execPath,
    [
      join(original, "scripts", "rea.mjs"),
      "analyze-javascript-application",
      target,
      "--json",
    ],
    {
      cwd: root,
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: environment,
      windowsHide: true,
    },
  );
  await writeFile(join(root, "original-cli.json"), baseline.stdout);
  const observed = JSON.stringify(result.value.normalized_result),
    oldText = JSON.stringify(JSON.parse(baseline.stdout));
  const report = {
    scope:
      "One real Electron ASAR static-analysis lane; mechanical execution, not model quality or broad provider parity",
    tool: "caller-installed @electron/asar",
    target_sha256: before,
    original_unchanged: before === (await digest()),
    new_command: result.value.normalized_result,
    original_channel_found: oldText.includes("kestrel:lookup:v3"),
    new_channel_found: observed.includes("kestrel:lookup:v3"),
    new_entrypoint_found: observed.includes(".webpack/main.js"),
    new_validation_found: observed.includes("query must be a string"),
    new_cap_found: observed.includes("slice(0,12)"),
    evidence_id: result.value.evidence_id,
    live_model: "not-tested; no inference requests or spend-ledger access",
  };
  for (const name of [
    "original_unchanged",
    "original_channel_found",
    "new_channel_found",
    "new_entrypoint_found",
    "new_validation_found",
    "new_cap_found",
  ])
    assert.equal(report[name], true, name);
  await writeFile(
    join(root, "provider-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await tools.close();
}
