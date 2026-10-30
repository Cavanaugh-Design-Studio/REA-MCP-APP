import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApp } from "../dist/server.js";
import { ok } from "../dist/retained/domain/result.js";
import {
  appRoot,
  originalRoot,
  assertPinnedNode,
  acceptanceEnvironment,
} from "./acceptance-paths.mjs";

// Finite, transparent fixture probes. A scripted internal agent exercises the
// production MCP/run/process/Evidence path; it does not measure model quality.
await assertPinnedNode();
const { values, positionals } = parseArgs({
  options: {
    original: { type: "string" },
    "require-full": { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const original = await originalRoot(values.original ?? positionals[0]);
const cache = join(appRoot, ".cache");
await mkdir(cache, { recursive: true });
const output = await mkdtemp(join(cache, "parity-"));
const temporary = join(output, "tmp");
await mkdir(temporary);
const environment = acceptanceEnvironment({
  REA_PROJECT_STORE: join(output, "projects.sqlite"),
  TEMP: temporary,
  TMP: temporary,
  TMPDIR: temporary,
});
const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const baselinePackage = await json(join(original, "package.json"));
const appPackage = await json(join(appRoot, "package.json"));
const launcher = join(original, "scripts/rea.mjs");
const identities = await Promise.all(
  [
    join(original, "package.json"),
    launcher,
    join(original, "dist/main.js"),
    join(original, "dist/cli.js"),
  ].map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
);

async function originalCommand(name, args) {
  const start = performance.now();
  let result;
  try {
    result = await exec(process.execPath, [launcher, ...args, "--json"], {
      cwd: output,
      env: environment,
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (cause) {
    await writeFile(
      join(output, `${name}-original-failure.json`),
      JSON.stringify(
        { code: cause.code, stdout: cause.stdout, stderr: cause.stderr },
        null,
        2,
      ),
    );
    throw new Error(
      `Original ${name} failed (${cause.code}); retained diagnostics in ${output}`,
    );
  }
  const value = JSON.parse(result.stdout);
  assert.ok(
    !value.error && !value.isError,
    `Original ${name} failed: ${JSON.stringify(value).slice(0, 500)}`,
  );
  await writeFile(
    join(output, `${name}-original.json`),
    JSON.stringify(value, null, 2),
  );
  return {
    value,
    elapsed_ms: performance.now() - start,
    response_bytes: Buffer.byteLength(result.stdout),
  };
}

// Search only structured keys/values, never a source-code substring masquerading
// as an extracted semantic relationship.
function hasProperty(value, key, expected) {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && value[key] === expected) return true;
  return Object.values(value).some((child) =>
    hasProperty(child, key, expected),
  );
}

async function assignedProbe(name, target, probe) {
  const contexts = [];
  let turn = 0;
  const engine = {
    models: { analyst: "fixture/scripted-probe", reviewer: null },
    async generate(request) {
      const context = JSON.parse(request.context);
      contexts.push({
        context_bytes: Buffer.byteLength(request.context),
        tool_definition_bytes: Buffer.byteLength(JSON.stringify(request.tools)),
        skill_bytes: Buffer.byteLength(request.skill),
      });
      assert.ok(request.skill.includes("leanrea"));
      const decision =
        turn++ === 0
          ? {
              kind: "tool",
              name: "run_command",
              arguments: {
                executable: process.execPath,
                arguments: ["--input-type=module", "-e", probe, context.target],
                timeout_ms: 30000,
                max_output_bytes: 131072,
              },
            }
          : {
              kind: "report",
              report: {
                findings: [
                  {
                    claim:
                      "The scripted probe returned the retained output for this finite fixture.",
                    evidence_ids: [context.latest_observation.evidence_id],
                    assumptions: [],
                  },
                ],
                unknowns: [
                  "Scripted decisions do not establish live-model tool selection, general reconstruction quality, or full provider parity.",
                ],
                next_steps: [],
              },
            };
      return ok({
        decision,
        requestedModel: engine.models.analyst,
        returnedModel: engine.models.analyst,
        provider: "simulated",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    },
  };
  const runtime = await createApp({ environment, engine });
  const client = new Client({ name: "parity-acceptance", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    return reply.structuredContent.result;
  };
  const start = performance.now();
  try {
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
    const assigned = await call("start_investigation", {
      question: `Run finite ${name} fixture probe`,
      target,
      workspace: join(output, "runs"),
      review: false,
    });
    let run;
    const deadline = Date.now() + 60000;
    do {
      run = await call("read_investigation", {
        run_id: assigned.run_id,
        include_sources: true,
        source_limit: 100,
      });
      if (run.state !== "running") break;
      assert.ok(Date.now() < deadline, "Assignment did not settle");
      await new Promise((done) => setTimeout(done, 25));
    } while (run.state === "running");
    await writeFile(
      join(output, `${name}-app.json`),
      JSON.stringify(run, null, 2),
    );
    assert.equal(run.state, "completed", JSON.stringify(run.limitations));
    assert.equal(run.interpretation, "inferred");
    const evidence = run.sources.find(
      (record) => record.operation === "run_local_command",
    );
    assert.ok(evidence, "No actual owned command Evidence");
    assert.equal(evidence.normalized_result.complete, true);
    assert.equal(evidence.normalized_result.exitCode, 0);
    assert.equal(evidence.normalized_result.cleanup, "verified");
    return {
      facts: JSON.parse(evidence.normalized_result.stdout.text),
      evidence_id: evidence.evidence_id,
      elapsed_ms: performance.now() - start,
      generations: run.generations.length,
      contexts,
      model_tokens: null,
      model_cost_usd: null,
    };
  } finally {
    await runtime.close();
    await client.close();
  }
}

const tasks = [];
const sourceDir = join(output, "electron-source");
await mkdir(join(sourceDir, ".webpack"), { recursive: true });
const channel = "parity:lookup:v4";
const entry = ".webpack/main.js";
const source = `const {ipcMain}=require('electron');\nipcMain.handle('${channel}',(_event,query)=>{if(typeof query!=='string')throw new TypeError('query must be a string');return ['alpha','beta'].filter(row=>row.includes(query)).slice(0,12);});\n`;
await writeFile(
  join(sourceDir, "package.json"),
  JSON.stringify({ name: "rea-parity-fixture", version: "1.0.0", main: entry }),
);
await writeFile(join(sourceDir, entry), source);
const requireOriginal = createRequire(join(original, "package.json"));
const asarPath = requireOriginal.resolve("@electron/asar");
const asar = await import(pathToFileURL(asarPath).href);
const archive = join(output, "electron.asar");
await asar.createPackage(sourceDir, archive);
for (const [name, target, archiveMode] of [
  ["electron-directory", sourceDir, false],
  ["electron-asar", archive, true],
]) {
  const before = archiveMode
    ? hash(await readFile(target))
    : hash(await readFile(join(target, entry)));
  const baseline = await originalCommand(name, [
    "analyze-javascript-application",
    target,
  ]);
  const reader = archiveMode
    ? `const a=await import(${JSON.stringify(pathToFileURL(asarPath).href)});const read=p=>a.extractFile(process.argv[1],p);`
    : `const {readFile}=await import('node:fs/promises');const {join}=await import('node:path');const read=p=>readFile(join(process.argv[1],p));`;
  const probe = `${reader}const p=JSON.parse((await read('package.json')).toString());const source=(await read(p.main)).toString();const {createHash}=await import('node:crypto');console.log(JSON.stringify({entry:p.main,source_sha256:createHash('sha256').update(source).digest('hex'),literal_channel:source.includes(${JSON.stringify(channel)}),validation:source.includes('query must be a string'),result_cap:source.includes('slice(0,12)')}));`;
  const current = await assignedProbe(name, target, probe);
  const checks = {
    package_entry:
      current.facts.entry === entry &&
      hasProperty(baseline.value, "main", entry),
    ipc_channel:
      current.facts.literal_channel &&
      hasProperty(baseline.value, "channel", channel),
    source_digest:
      current.facts.source_sha256 === hash(source) &&
      hasProperty(baseline.value, "sha256", hash(source)),
    original_unchanged:
      before ===
      (archiveMode
        ? hash(await readFile(target))
        : hash(await readFile(join(target, entry)))),
  };
  for (const [check, passed] of Object.entries(checks))
    assert.equal(passed, true, `${name}: ${check}`);
  tasks.push({
    name,
    state: "passed-bounded",
    checks,
    app_only_observations: {
      validation_literal: current.facts.validation,
      result_cap_literal: current.facts.result_cap,
    },
    original: {
      elapsed_ms: baseline.elapsed_ms,
      response_bytes: baseline.response_bytes,
    },
    app: current,
    limits: [
      "Literal source recovery is not AST relationship extraction or observed runtime registration. Validation/cap literals were not matched against original semantic analysis.",
      "The baseline performs a full structured analysis; app timing covers only this focused scripted probe. Timings are not an efficiency or model benchmark.",
    ],
  });
}

// Offline historical capture: .invalid destinations must never be fetched.
const har = join(output, "history.har");
const url = "https://rea-parity.invalid/api/items";
const payload = "parity-payload-v4";
await writeFile(
  har,
  JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "REA parity fixture", version: "1" },
      entries: [
        {
          startedDateTime: "2026-10-29T00:00:00Z",
          time: 1,
          request: {
            method: "GET",
            url,
            httpVersion: "HTTP/1.1",
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: 200,
            statusText: "OK",
            httpVersion: "HTTP/1.1",
            headers: [],
            cookies: [],
            content: {
              size: payload.length,
              mimeType: "text/plain",
              text: payload,
            },
            redirectURL: "",
            headersSize: -1,
            bodySize: payload.length,
          },
          cache: {},
          timings: { send: 0, wait: 1, receive: 0 },
        },
      ],
    },
  }),
);
const harBefore = hash(await readFile(har));
const baselineHar = await originalCommand("offline-har", [
  "inspect-web-network-capture",
  har,
  "har",
]);
const currentHar = await assignedProbe(
  "offline-har",
  har,
  `const {readFile}=await import('node:fs/promises');const h=JSON.parse(await readFile(process.argv[1],'utf8'));console.log(JSON.stringify(h.log.entries.map(e=>({url:e.request.url,status:e.response.status,text:e.response.content.text}))));`,
);
const harChecks = {
  url:
    currentHar.facts[0].url === url &&
    hasProperty(baselineHar.value, "url", url),
  status:
    currentHar.facts[0].status === 200 &&
    hasProperty(baselineHar.value, "status", 200),
  payload:
    currentHar.facts[0].text === payload &&
    hasProperty(baselineHar.value, "text", payload),
  original_unchanged: harBefore === hash(await readFile(har)),
};
for (const [check, passed] of Object.entries(harChecks))
  assert.equal(passed, true, `offline-har: ${check}`);
tasks.push({
  name: "offline-har",
  state: "passed-bounded",
  checks: harChecks,
  original: {
    elapsed_ms: baselineHar.elapsed_ms,
    response_bytes: baselineHar.response_bytes,
  },
  app: currentHar,
  limits: [
    "Public fixture fields only. Canonical network identities, credential redaction, malformed input, mitmproxy, and browser capture parity are unverified.",
  ],
});

const catalogProcess = await exec(
  process.execPath,
  [join(appRoot, "scripts/measure-catalog.mjs"), launcher],
  {
    cwd: appRoot,
    env: environment,
    timeout: 60000,
    maxBuffer: 1048576,
    windowsHide: true,
  },
);
const catalog = JSON.parse(catalogProcess.stdout);
assert.equal(catalog.current.model_facing_tools, 4);
assert.ok(
  catalog.current.all_definition_bytes < catalog.baseline.all_definition_bytes,
);

// Compare actual npm pack lists without lifecycle scripts, installs, or network.
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run with the pinned npm: npm run verify:parity");
const npmVersion = (
  await exec(process.execPath, [npmCli, "--version"], {
    cwd: output,
    env: environment,
    windowsHide: true,
  })
).stdout.trim();
assert.equal(`npm@${npmVersion}`, appPackage.packageManager);
async function pack(root) {
  const packed = await exec(
    process.execPath,
    [
      npmCli,
      "pack",
      "--dry-run",
      "--ignore-scripts",
      "--offline",
      "--json",
      "--cache",
      join(output, "npm-cache"),
    ],
    {
      cwd: root,
      env: environment,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const [value] = JSON.parse(packed.stdout);
  return {
    package_bytes: value.size,
    unpacked_bytes: value.unpackedSize,
    file_count: value.files.length,
    files: value.files.map((file) => file.path),
  };
}
const appPack = await pack(appRoot),
  originalPack = await pack(original);
assert.ok(appPack.files.includes("dist/ui/workbench.html"));
assert.ok(appPack.files.includes("leanrea/SKILL.md"));
assert.ok(
  !appPack.files.some(
    (path) =>
      /(?:^|\/)(?:\.env(?:\.|$)|\.cache\/|node_modules\/)/u.test(path) &&
      path !== ".env.example",
  ),
);
if (process.platform === "win32")
  assert.ok(
    appPack.files.some(
      (path) =>
        path.startsWith("native/windows/build/") && path.endsWith(".node"),
    ),
  );
assert.ok(appPack.unpacked_bytes < originalPack.unpacked_bytes);
for (const identity of identities)
  assert.equal(hash(await readFile(identity.path)), identity.sha256);
const { files: appFiles, ...appFootprint } = appPack,
  { files: originalFiles, ...originalFootprint } = originalPack;
await writeFile(
  join(output, "package-file-lists.json"),
  JSON.stringify({ app: appFiles, original: originalFiles }, null, 2),
);
const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  scope:
    "Three finite static tasks through MCP assignments and real owned commands; scripted internal decisions; no inference, downloads, installs, or original-provider runtime dependency.",
  universal_parity: "unverified",
  live_model_quality: "not-tested",
  model_efficiency: "not-tested",
  toolchain: { node: process.version, npm: npmVersion },
  baseline: {
    name: baselinePackage.name,
    version: baselinePackage.version,
    root: original,
    identities,
  },
  catalog,
  footprint: {
    app: appFootprint,
    original: originalFootprint,
    unpacked_reduction:
      1 - appFootprint.unpacked_bytes / originalFootprint.unpacked_bytes,
    limits: [
      "npm package payloads exclude installed dependencies and external utilities; this is not RSS, startup latency, or total installation size.",
    ],
  },
  tasks,
  coverage: (
    await json(join(appRoot, "docs/capability-parity.json"))
  ).families.map((family) => ({
    ...family,
    state: ["javascript", "network-captures"].includes(family.id)
      ? "partial"
      : "unverified",
  })),
  output,
};
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
await writeFile(
  join(cache, "parity-latest.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      report: join(output, "report.json"),
      bounded_tasks_passed: tasks.length,
      model_facing_tools: catalog.current.model_facing_tools,
      model_definition_bytes: catalog.current.model_definition_bytes,
      unpacked_package_reduction: report.footprint.unpacked_reduction,
      universal_parity: report.universal_parity,
    },
    null,
    2,
  ),
);
if (values["require-full"] && report.universal_parity !== "verified") {
  console.error(
    "Full parity acceptance is incomplete. See the retained report coverage and live-model limits.",
  );
  process.exitCode = 1;
}
