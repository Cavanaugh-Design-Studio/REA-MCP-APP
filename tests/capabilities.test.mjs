import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { inspect } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createApp } from "../dist/server.js";
import { ok } from "../dist/retained/domain/result.js";
import { LocalTools } from "../dist/localTools.js";
import { taskInputSchema } from "../dist/contracts.js";
import { DeviceCapture } from "../dist/analysis/DeviceCapture.js";
import { spawnOwnedProviderProcess } from "../dist/retained/process/ProviderProcess.js";
import { analysisToolDefinitions } from "../dist/analysis/contracts.js";
import { parseEvidence } from "../dist/retained/domain/evidence.js";
import { browserScenarioSource } from "../dist/retained/domain/browserScenarioVerification.js";
import { compareBrowserScenarioEvidence } from "../dist/retained/application/features/BrowserScenarioComparison.js";
import { createEvidenceBundle } from "../dist/retained/domain/evidenceBundle.js";
import { verifyReconstruction } from "../dist/retained/domain/reconstructionVerification.js";
import { inspectStructuredView } from "../dist/analysis/AnalysisViews.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
} from "./fixtures/managed-pe.mjs";

if (process.platform === "win32")
  process.env.REA_WINDOWS_NATIVE_DIR = resolve("native/windows/build");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function directory() {
  await mkdir(".cache/capability-tests", { recursive: true });
  return await mkdtemp(resolve(".cache/capability-tests/test-"));
}
const environment = (root) => ({
  PATH: process.env.PATH ?? process.env.Path,
  SystemRoot: process.env.SystemRoot,
  TEMP: root,
  TMP: root,
  REA_PROJECT_STORE: join(root, "projects.sqlite"),
  OPENROUTER_API_KEY: "must-not-reach-analysis-children",
});
async function assignment(root, target, decide, budget) {
  let turn = 0;
  const engine = {
    models: { analyst: "fixture/capability-agent", reviewer: null },
    async generate(request) {
      const context = JSON.parse(request.context);
      assert.ok(
        request.tools.some(
          (tool) => tool.name === "analyze_javascript_application",
        ),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(request.tools)) < 16384);
      const decision = decide(context, turn++);
      return ok({
        decision,
        requestedModel: "fixture/capability-agent",
        returnedModel: "fixture/capability-agent",
        provider: "simulated",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    },
  };
  const app = await createApp({ environment: environment(root), engine });
  const client = new Client({ name: "capability-acceptance", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await app.server.connect(b);
  await client.connect(a);
  const call = async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    return reply.structuredContent.result ?? reply.structuredContent;
  };
  try {
    const started = await call("start_investigation", {
      question: "Inspect fixture through internal tools",
      target,
      workspace: join(root, "runs"),
      review: false,
      ...(budget ? { budget } : {}),
    });
    const deadline = Date.now() + 90000;
    let run;
    do {
      run = await call("read_investigation", {
        run_id: started.run_id,
        include_sources: true,
        source_limit: 100,
      });
      if (run.state !== "running") break;
      assert.ok(Date.now() < deadline, "Assignment timeout");
      await new Promise((done) => setTimeout(done, 25));
    } while (run.state === "running");
    assert.equal(run.state, "completed", JSON.stringify(run));
    await writeFile(join(root, "run.json"), JSON.stringify(run, null, 2));
    return {
      run,
      call,
      close: async () => {
        await app.close();
        await client.close();
      },
    };
  } catch (cause) {
    await app.close();
    await client.close();
    throw cause;
  }
}
const report = (ctx) => ({
  kind: "report",
  report: {
    findings: [
      {
        claim: "The requested structured observations are retained.",
        evidence_ids: [ctx.latest_observation.evidence_id],
        assumptions: [],
      },
    ],
    unknowns: ["Scripted decisions do not establish live-model quality."],
    next_steps: [],
  },
});

test("one assignment builds canonical AST/module/IPC graphs and bounded views without executing the target", async () => {
  const root = await directory(),
    target = join(root, "source");
  await mkdir(target);
  await writeFile(
    join(target, "package.json"),
    JSON.stringify({ name: "graph-fixture", version: "1", main: "main.js" }),
  );
  await writeFile(
    join(target, "main.js"),
    "const {ipcMain}=require('electron');const fs=require('node:fs');ipcMain.handle('fixture:lookup',(_e,q)=>String(q).slice(0,8));throw new Error('TARGET MUST NOT EXECUTE');\n",
  );
  const host = await assignment(
    root,
    target,
    (ctx, turn) => {
      if (turn === 1) assert.ok(ctx.latest_observation.context_selection);
      return turn === 0
        ? {
            kind: "tool",
            name: "analyze_javascript_application",
            arguments: {},
          }
        : turn === 1
          ? {
              kind: "tool",
              name: "inspect_analysis_view",
              arguments: {
                evidence_id: ctx.latest_observation.evidence_id,
                view: { kind: "summary" },
              },
            }
          : report(ctx);
    },
    { max_context_bytes: 32768 },
  );
  try {
    const evidence = host.run.sources.find(
      (source) => source.operation === "analyze_javascript_application",
    );
    assert.ok(evidence);
    parseEvidence(evidence);
    const graph = evidence.normalized_result.graph;
    assert.ok(
      graph.nodes.some(
        (node) =>
          node.kind === "ipc-handler" &&
          node.observations.some(
            (observation) =>
              observation.properties.channel === "fixture:lookup",
          ),
      ),
    );
    assert.ok(graph.edges.length > 0);
    assert.ok(
      host.run.sources.some(
        (source) => source.operation === "inspect_analysis_view",
      ),
    );
    assert.equal(
      host.run.sources.some(
        (source) => source.operation === "local_tool_failure",
      ),
      false,
    );
  } finally {
    await host.close();
  }
});

test("managed identity, CIL, native declarations and graph retain exact metadata scopes", async () => {
  const root = await directory(),
    target = join(root, "managed"),
    bytes = buildManagedPeFixture();
  await mkdir(target);
  await writeFile(join(target, "fixture.dll"), bytes);
  await writeFile(
    join(target, "pinvoke.dll"),
    buildManagedPeFixture({
      pinvoke: { moduleName: "native-fixture", importName: "lookup" },
    }),
  );
  const facets = ["identity", "members", "native-boundaries"];
  const host = await assignment(root, target, (ctx, turn) =>
    turn < 3
      ? {
          kind: "tool",
          name: "inspect_managed_code",
          arguments: {
            path: join(ctx.target, "fixture.dll"),
            facet: facets[turn],
          },
        }
      : turn === 3
        ? {
            kind: "tool",
            name: "project_analysis_graph",
            arguments: {
              evidence_ids: ctx.sources
                .filter((source) =>
                  source.operation.startsWith("inspect_managed_"),
                )
                .map((source) => source.evidence_id),
            },
          }
        : turn === 4
          ? {
              kind: "tool",
              name: "inspect_managed_code",
              arguments: {
                path: join(ctx.target, "pinvoke.dll"),
                facet: "native-boundaries",
              },
            }
          : report(ctx),
  );
  try {
    const records = host.run.sources.filter(
      (source) =>
        source.operation.startsWith("inspect_managed_") &&
        source.subject.digest.sha256 === digest(bytes),
    );
    assert.equal(records.length, 3);
    for (const source of records) {
      assert.equal(source.subject.digest.sha256, digest(bytes));
      parseEvidence(source);
    }
    const members = records.find(
      (source) => source.operation === "inspect_managed_members",
    ).normalized_result;
    assert.equal(members.types[0].full_name, "Fixture.Program");
    assert.equal(members.methods[0].body.decoded_instruction_count, 4);
    assert.equal(members.methods[0].body.opcode_counts.call, 1);
    assert.equal(members.methods[0].body.anchors[0].il_offset, 1);
    const boundary = host.run.sources.find(
      (source) =>
        source.operation === "inspect_managed_native_boundaries" &&
        source.subject.digest.sha256 !== digest(bytes),
    );
    assert.ok(
      JSON.stringify(boundary.normalized_result.pinvoke_imports).includes(
        "lookup",
      ),
    );
    const graph = host.run.sources.find(
      (source) => source.operation === "project_managed_application_graph",
    );
    assert.ok(graph.normalized_result.graph.nodes.length > 0);
    assert.equal(graph.confidence, "inferred");
    assert.equal(graph.evidence_links.length, 3);
    const view = await host.call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: records[1].evidence_id,
      },
      view: { kind: "page", collection: "methods", offset: 0, limit: 1 },
    });
    assert.equal(view.normalized_result.items.length, 1);
    assert.equal(
      digest(await readFile(join(target, "fixture.dll"))),
      digest(bytes),
    );
    const tampered = structuredClone(records[1]);
    tampered.normalized_result.artifact.sha256 = "0".repeat(64);
    assert.equal(
      inspectStructuredView(tampered, { kind: "summary" }).ok,
      false,
    );
  } finally {
    await host.close();
  }
});

test("missing native engine is an explicit capability failure and never fabricated pseudocode", async () => {
  const root = await directory(),
    target = join(root, "native.exe");
  await writeFile(target, buildNativePeFixture());
  const tools = new LocalTools(environment(root));
  try {
    const signal = new AbortController().signal,
      workspace = await tools.prepare(
        "native",
        taskInputSchema.parse({
          question: "Native",
          target,
          workspace: join(root, "runs"),
        }),
        signal,
      );
    const result = await tools.execute(
      "inspect_native_code",
      {},
      workspace,
      "native",
      signal,
      [],
    );
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisCapabilityUnavailableError");
  } finally {
    await tools.close();
  }
});

test("device acquisition preserves raw PNG bytes, selected serial, exact destination and clean child environment", async () => {
  const root = await directory(),
    owners = new Set();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0QAAAABJRU5ErkJggg==",
    "base64",
  );
  const device = new DeviceCapture(
    environment(root),
    owners,
    async () => process.execPath,
    async (options) => {
      assert.deepEqual(options.arguments, [
        "-s",
        "selected-serial",
        "exec-out",
        "screencap",
        "-p",
      ]);
      assert.equal(options.hostEnvironment.OPENROUTER_API_KEY, undefined);
      return await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(Buffer.from('${png.toString("base64")}','base64'))`,
        ],
      });
    },
  );
  const path = async (supplied) => join(root, supplied),
    signal = new AbortController().signal;
  const evidence = await device.capture(
    { serial: "selected-serial", capture: "screen", output_path: "caller.png" },
    path,
    root,
    signal,
  );
  assert.deepEqual(await readFile(join(root, "caller.png")), png);
  assert.equal(evidence.normalized_result.complete, true);
  assert.equal(evidence.normalized_result.sha256, digest(png));
  assert.equal(evidence.normalized_result.width, 1);
  assert.equal(owners.size, 0);
  await assert.rejects(
    device.capture(
      {
        serial: "selected-serial",
        capture: "screen",
        output_path: "caller.png",
      },
      path,
      root,
      signal,
    ),
    /EEXIST/u,
  );
});

const browser =
  process.env.REA_TEST_BROWSER ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
test(
  "real owned browser produces canonical DOM/screenshot capture and drains its profile",
  {
    skip:
      !existsSync(browser) &&
      "Select an installed browser with REA_TEST_BROWSER",
  },
  async () => {
    const root = await directory(),
      server = createServer((_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(
          '<!doctype html><title>REA capture</title><button id="go" onclick="this.textContent=\'done\'">go</button>',
        );
      });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const tools = new LocalTools(environment(root));
    try {
      const signal = new AbortController().signal,
        workspace = await tools.prepare(
          "browser",
          taskInputSchema.parse({
            question: "Capture",
            target: url,
            workspace: join(root, "runs"),
          }),
          signal,
        );
      const result = await tools.execute(
        "capture_browser_scenario",
        {
          scenario: {
            browser: {
              mode: "launch",
              executable_path: browser,
              headless: true,
            },
            start_url: { url, query: [] },
            environment: {},
            actions: [
              {
                step_id: "click",
                action: "click",
                locator: { kind: "css", selector: "#go" },
              },
            ],
            capture: {
              after_each_step: ["dom"],
              at_end: ["dom", "screenshot"],
            },
          },
        },
        workspace,
        "browser",
        signal,
        [],
      );
      assert.equal(
        result.ok,
        true,
        result.ok ? "" : inspect(result.error, { depth: 8 }),
      );
      const evidence = browserScenarioSource(result.value);
      assert.equal(evidence.authority, "controlled-replay");
      assert.equal(
        evidence.normalized_result.browser.cleanup,
        "terminated-owned-process",
      );
      assert.ok(
        evidence.normalized_result.steps
          .at(-1)
          .artifacts.dom.value.text.includes("done"),
      );
      assert.equal(
        evidence.normalized_result.steps.at(-1).artifacts.screenshot.state,
        "captured",
      );
      assert.equal(
        (await readdir(workspace.root)).some((name) =>
          name.startsWith("rea-browser-scenario-"),
        ),
        false,
      );
      assert.equal(evidence.raw_result.processes.length, 1);
      assert.notEqual(
        evidence.raw_result.processes[0].cleanup.status,
        "incomplete",
      );
      await writeFile(
        join(root, "browser-evidence.json"),
        JSON.stringify(evidence, null, 2),
      );
      // Parameters carry their scenario commitment; replay only the committed input.
      const { scenario_sha256: _scenario_sha256, ...repeatScenario } = evidence.parameters;
      const repeated = await tools.execute(
        "capture_browser_scenario",
        { scenario: repeatScenario },
        workspace,
        "browser-repeat",
        signal,
        [],
      );
      assert.equal(repeated.ok, true, inspect(repeated));
      assert.equal(
        repeated.value.operation,
        "capture_browser_scenario",
        JSON.stringify(repeated.value.normalized_result),
      );
      const comparison = compareBrowserScenarioEvidence({
        left: evidence,
        right: repeated.value,
      });
      assert.equal(comparison.ok, true, inspect(comparison));
      const proof = verifyReconstruction(
        {
          name: "Executed DOM and screenshot fixture",
          claims: [
            {
              claim_id: "click-result",
              title: "Same click result",
              kind: "browser-behavior",
              dimension: "overall",
              comparison_evidence_id: comparison.value.evidence_id,
            },
          ],
        },
        createEvidenceBundle([evidence, repeated.value, comparison.value]),
      );
      assert.equal(proof.status, "pass", JSON.stringify(proof));
      await writeFile(
        join(root, "browser-verification.json"),
        JSON.stringify(proof, null, 2),
      );
    } finally {
      try {
        await tools.close();
      } finally {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
    }
  },
);

test("internal semantic tool catalog stays bounded and names no original registration catalog", () => {
  assert.equal(analysisToolDefinitions.length, 7);
  assert.ok(Buffer.byteLength(JSON.stringify(analysisToolDefinitions)) < 10000);
});
