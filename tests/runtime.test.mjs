import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { createApp, MODEL_TOOL_NAMES, APP_TOOL_NAMES } from "../dist/server.js";
import { ok } from "../dist/retained/domain/result.js";
import { createEvidenceBundle } from "../dist/retained/domain/evidenceBundle.js";
import { browserCapture } from "./fixtures/browser-capture.mjs";
import { createEvidence } from "../dist/retained/domain/evidence.js";
import {
  recomputeBrowserScenarioComparison,
  browserReplayEnvironmentCompatible,
} from "../dist/retained/domain/browserScenarioVerification.js";
import { verifyReconstruction } from "../dist/retained/domain/reconstructionVerification.js";
import { analysisToolDefinitions } from "../dist/analysis/contracts.js";
import { researchToolDefinitions } from "../dist/research/contracts.js";

const nativeDirectory =
  process.env.REA_WINDOWS_NATIVE_DIR ?? resolve("native/windows/build");
if (
  process.platform === "win32" &&
  existsSync(join(nativeDirectory, "manifest.json"))
)
  process.env.REA_WINDOWS_NATIVE_DIR = nativeDirectory;
const nativeAvailable =
  process.platform !== "win32" || Boolean(process.env.REA_WINDOWS_NATIVE_DIR);
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
async function directory() {
  await mkdir(".cache/tests", { recursive: true });
  return await mkdtemp(resolve(".cache/tests/run-"));
}
const receipt = (decision) =>
  ok({
    decision,
    requestedModel: "fixture/internal-agent",
    returnedModel: "fixture/internal-agent",
    provider: "simulated",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: null,
  });
const report = (ctx) =>
  receipt({
    kind: "report",
    report: {
      findings: ctx.sources.length
        ? [
            {
              claim:
                "The returned command output is retained as observed Evidence.",
              evidence_ids: [ctx.sources.at(-1).evidence_id],
              assumptions: [],
            },
          ]
        : [],
      unknowns: [
        "This fixture does not establish real model quality or native decompilation.",
      ],
      next_steps: [],
    },
  });
async function connected(engine) {
  const root = await directory();
  const runtime = await createApp({
    environment: {
      PATH: process.env.PATH ?? process.env.Path,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      OPENROUTER_API_KEY: "must-not-reach-child",
      REA_PROJECT_STORE: join(root, "projects.sqlite"),
    },
    ...(engine ? { engine } : {}),
  });
  const client = new Client({ name: "restart-acceptance", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(b);
  await client.connect(a);
  const calls = [];
  const raw = async (name, args = {}) => {
    calls.push(name);
    return await client.callTool({ name, arguments: args });
  };
  const call = async (name, args = {}) => {
    const reply = await raw(name, args);
    assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
    return reply.structuredContent?.result ?? reply.structuredContent;
  };
  return {
    root,
    runtime,
    client,
    calls,
    raw,
    call,
    close: async () => {
      await runtime.close();
      await client.close();
    },
  };
}
async function terminal(host, id) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await host.call("read_investigation", {
      run_id: id,
      include_sources: true,
      source_limit: 100,
    });
    if (value.state !== "running") return value;
    await pause(25);
  }
  throw new Error("Run did not settle");
}

test("real MCP catalog declares four model-facing and eleven App-only operations", async () => {
  const host = await connected();
  try {
    const catalog = await host.client.listTools();
    const model = catalog.tools.filter(
      (tool) =>
        tool._meta?.ui?.visibility?.includes("model") ||
        !tool._meta?.ui?.visibility,
    );
    assert.deepEqual(
      model.map((tool) => tool.name).sort(),
      [...MODEL_TOOL_NAMES].sort(),
    );
    assert.equal(
      catalog.tools.length,
      MODEL_TOOL_NAMES.length + APP_TOOL_NAMES.length,
    );
    assert.equal(model.length, 4);
    const allBytes = Buffer.byteLength(JSON.stringify(catalog.tools));
    const modelBytes = Buffer.byteLength(JSON.stringify(model));
    assert.ok(
      modelBytes < 6000,
      `Model catalog grew to ${modelBytes} bytes; review footprint`,
    );
    assert.ok(
      allBytes < 12000,
      `Complete catalog grew to ${allBytes} bytes; review footprint`,
    );
    for (const tool of catalog.tools.filter((tool) => !model.includes(tool))) {
      assert.deepEqual(tool._meta.ui.visibility, ["app"], tool.name);
    }
    assert.equal(
      catalog.tools.some(
        (tool) =>
          tool.name === "run_command" ||
          tool.name === "open_binary" ||
          tool.name === "list_adb_devices",
      ),
      false,
    );
    const validator = new AjvJsonSchemaValidator();
    for (const tool of catalog.tools) {
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.doesNotThrow(
        () => validator.getValidator(tool.inputSchema),
        tool.name,
      );
    }
    const status = await host.call("rea_workbench");
    assert.equal(status.engine.enabled, false);
    assert.equal(
      (
        await host.raw("start_investigation", {
          question: "Inspect",
          review: false,
        })
      ).isError,
      true,
    );
    const resources = await host.client.listResources();
    assert.ok(
      resources.resources.some(
        (resource) => resource.uri === "ui://rea/workbench.html",
      ),
    );
    const html = await host.client.readResource({
      uri: "ui://rea/workbench.html",
    });
    assert.equal(html.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.ok(html.contents[0].text.includes("Target path or URL"));
    const guide = await host.client.readResource({ uri: "rea://internal/skills/leanrea" });
    assert.equal(guide.contents[0].mimeType, "text/markdown");
    assert.equal(guide.contents[0].text, await readFile(new URL("../leanrea/SKILL.md", import.meta.url), "utf8"));
    await writeFile(
      join(host.root, "catalog.json"),
      JSON.stringify(
        {
          total: catalog.tools.length,
          model_facing: model.length,
          all_definition_bytes: Buffer.byteLength(
            JSON.stringify(catalog.tools),
          ),
          model_definition_bytes: Buffer.byteLength(JSON.stringify(model)),
        },
        null,
        2,
      ),
    );
  } finally {
    await host.close();
  }
});

test(
  "one client task causes internal file/command execution and an Evidence-backed report",
  { skip: !nativeAvailable && "Verified Windows native authority unavailable" },
  async () => {
    let requests = 0;
    const engine = {
      models: { analyst: "fixture/analyst", reviewer: null },
      generate: async (request) => {
        requests++;
        const ctx = JSON.parse(request.context);
        assert.ok(request.skill.includes("leanrea: fast path"));
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          [
            "run_command",
            "read_file",
            "write_file",
            "list_files",
            ...analysisToolDefinitions.map((tool) => tool.name),
            ...researchToolDefinitions.filter((tool) => tool.name !== "search_web").map((tool) => tool.name),
          ],
        );
        if (requests === 1)
          return receipt({
            kind: "tool",
            name: "run_command",
            arguments: {
              executable: process.execPath,
              arguments: [
                "-e",
                "const fs=require('node:fs'); const t=fs.readFileSync(process.argv[1],'utf8'); console.log(JSON.stringify({hasIpc:t.includes('ipcMain.handle'),credentialPresent:!!process.env.OPENROUTER_API_KEY}));",
                ctx.target,
              ],
              timeout_ms: 10000,
            },
          });
        assert.equal(ctx.latest_observation.operation, "run_local_command");
        assert.equal(
          ctx.latest_observation.normalized_result.cleanup,
          "verified",
        );
        assert.deepEqual(
          JSON.parse(ctx.latest_observation.normalized_result.stdout.text),
          { hasIpc: true, credentialPresent: false },
        );
        return report(ctx);
      },
    };
    const host = await connected(engine);
    try {
      const target = join(host.root, "original.js"),
        content = "ipcMain.handle('notes:search', searchNotes);\n";
      await writeFile(target, content);
      const started = await host.call("start_investigation", {
        question: "Find the IPC boundary",
        target,
        workspace: host.root,
        review: false,
      });
      const value = await terminal(host, started.run_id);
      assert.equal(value.state, "completed", JSON.stringify(value.limitations));
      assert.equal(requests, 2);
      assert.equal(await readFile(target, "utf8"), content);
      assert.ok(value.sources.every((item) => item.confidence !== "inferred"));
      assert.equal(value.interpretation, "inferred");
      assert.deepEqual(
        [...new Set(host.calls)],
        ["start_investigation", "read_investigation"],
      );
      assert.ok(
        value.sources.some((item) => item.operation === "prepare_working_copy"),
      );
      const bundle = await host.call("get_evidence_bundle");
      assert.equal(bundle.records.length, value.sources.length);
    } finally {
      await host.close();
    }
  },
);

test(
  "missing executables are retained and the internal agent can choose a fallback",
  { skip: !nativeAvailable && "Verified Windows native authority unavailable" },
  async () => {
    let requests = 0;
    const engine = {
      models: { analyst: "fixture/a", reviewer: null },
      generate: async (request) => {
        const ctx = JSON.parse(request.context);
        requests++;
        if (requests === 1)
          return receipt({
            kind: "tool",
            name: "run_command",
            arguments: {
              executable: "rea-fixture-no-such-executable",
              arguments: [],
            },
          });
        if (requests === 2) {
          assert.equal(ctx.latest_observation.operation, "local_tool_failure");
          return receipt({
            kind: "tool",
            name: "run_command",
            arguments: {
              executable: process.execPath,
              arguments: ["-e", "console.log('fallback-observed')"],
            },
          });
        }
        return report(ctx);
      },
    };
    const host = await connected(engine);
    try {
      const started = await host.call("start_investigation", {
        question: "Use an installed fallback",
        workspace: host.root,
      });
      const value = await terminal(host, started.run_id);
      assert.equal(value.state, "completed");
      assert.equal(requests, 3);
      assert.ok(
        value.sources.some((item) => item.operation === "local_tool_failure"),
      );
    } finally {
      await host.close();
    }
  },
);

test(
  "command output limits retain partial observations and never become completed reports",
  { skip: !nativeAvailable && "Verified Windows native authority unavailable" },
  async () => {
    const engine = {
      models: { analyst: "fixture/a", reviewer: null },
      generate: async () =>
        receipt({
          kind: "tool",
          name: "run_command",
          arguments: {
            executable: process.execPath,
            arguments: ["-e", "console.log('x'.repeat(8192))"],
            max_output_bytes: 64,
          },
        }),
    };
    const host = await connected(engine);
    try {
      const started = await host.call("start_investigation", {
        question: "Collect bounded output",
        workspace: host.root,
      });
      const value = await terminal(host, started.run_id);
      assert.equal(value.state, "limited");
      const command = value.sources.find(
        (item) => item.operation === "run_local_command",
      );
      assert.equal(command.normalized_result.complete, false);
      assert.ok(command.normalized_result.stdout.bytes <= 64);
      assert.ok(
        command.normalized_result.stdout.observedBytes >
          command.normalized_result.stdout.bytes,
      );
    } finally {
      await host.close();
    }
  },
);

test(
  "cancellation drains a real owned process and its detached descendant",
  { skip: !nativeAvailable && "Verified Windows native authority unavailable" },
  async () => {
    const engine = {
      models: { analyst: "fixture/a", reviewer: null },
      generate: async (request) => {
        const ctx = JSON.parse(request.context);
        return receipt({
          kind: "tool",
          name: "run_command",
          arguments: {
            executable: process.execPath,
            arguments: [
              "-e",
              "const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid}));console.log(c.pid);setInterval(()=>{},1000)",
              join(ctx.workspace, "started.json"),
            ],
            timeout_ms: 30000,
          },
        });
      },
    };
    const host = await connected(engine);
    try {
      const started = await host.call("start_investigation", {
        question: "Cancellation fixture",
        workspace: host.root,
      });
      const ready = join(host.root, started.run_id, "started.json");
      let pids;
      for (let n = 0; n < 200; n++) {
        try {
          pids = JSON.parse(await readFile(ready, "utf8"));
          break;
        } catch {
          await pause(25);
        }
      }
      assert.ok(pids, "Owned command did not reach its ready marker");
      await host.call("cancel_investigation", { run_id: started.run_id });
      const value = await terminal(host, started.run_id);
      assert.equal(value.state, "cancelled");
      for (const pid of [pids.parent, pids.child])
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.ok(
        value.sources.some((item) => item.operation === "run_local_command"),
      );
    } finally {
      await host.close();
    }
  },
);

test("workspace traversal fails without modifying the outside file", async () => {
  let requests = 0;
  const engine = {
    models: { analyst: "fixture/a", reviewer: null },
    generate: async (request) => {
      const ctx = JSON.parse(request.context);
      if (++requests === 1)
        return receipt({
          kind: "tool",
          name: "write_file",
          arguments: { path: "../outside.txt", content: "changed" },
        });
      assert.equal(ctx.latest_observation.operation, "local_tool_failure");
      return report(ctx);
    },
  };
  const host = await connected(engine);
  try {
    await writeFile(join(host.root, "outside.txt"), "preserved");
    const started = await host.call("start_investigation", {
      question: "Traversal fixture",
      workspace: host.root,
    });
    assert.equal((await terminal(host, started.run_id)).state, "completed");
    assert.equal(
      await readFile(join(host.root, "outside.txt"), "utf8"),
      "preserved",
    );
  } finally {
    await host.close();
  }
});

test("canonical project history, bundle identity, stale revisions and handoff remain local", async () => {
  const host = await connected();
  try {
    const bundle = createEvidenceBundle([]);
    const definition = {
      title: "Local feature",
      goal: "Retain explicit unknowns",
      original: {
        kind: "artifact",
        location: "C:/fixture/input.bin",
        sha256: null,
      },
      candidate: null,
      evidence_bundle: bundle,
      obligations: {
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      },
      specification: null,
      cases: [],
      notes: [],
    };
    const created = await host.call("create_feature_project", definition);
    const read = await host.call("read_feature_project", {
      project_id: created.project_id,
    });
    assert.equal(read.readiness.state, "unknown");
    const updated = await host.call("revise_feature_project", {
      project_id: created.project_id,
      expected_revision: 1,
      definition: { ...definition, notes: ["preserved"] },
    });
    assert.equal(updated.revision, 2);
    assert.equal(
      (
        await host.raw("revise_feature_project", {
          project_id: created.project_id,
          expected_revision: 1,
          definition,
        })
      ).isError,
      true,
    );
    const old = await host.call("read_feature_project", {
      project_id: created.project_id,
      revision: 1,
    });
    assert.deepEqual(old.project.definition.notes, []);
    const output = join(host.root, "handoff");
    await host.call("export_feature_handoff", {
      project_id: created.project_id,
      output_directory: output,
    });
    const receipt = JSON.parse(
      await readFile(join(output, "handoff-receipt.json"), "utf8"),
    );
    for (const file of receipt.files)
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(output, file.path)))
          .digest("hex"),
        file.sha256,
      );
    assert.equal(
      (
        await host.raw("export_feature_handoff", {
          project_id: created.project_id,
          output_directory: output,
        })
      ).isError,
      true,
    );
  } finally {
    await host.close();
  }
});

test("legacy canonical Evidence retains its exact IDs and rejects tampering", async () => {
  const host = await connected();
  try {
    const legacy = JSON.parse(
      await readFile(
        new URL("./fixtures/legacy-evidence.json", import.meta.url),
        "utf8",
      ),
    );
    const path = join(host.root, "legacy.json");
    await writeFile(path, JSON.stringify(legacy));
    const imported = await host.call("import_evidence_bundle", { path });
    assert.deepEqual(
      imported.records.map((item) => item.evidence_id),
      legacy.records.map((item) => item.evidence_id),
    );
    const output = join(host.root, "export.json");
    await host.call("export_evidence_bundle", { path: output });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), legacy);
    const tampered = structuredClone(legacy);
    tampered.records[0].normalized_result = { substituted: true };
    await writeFile(path, JSON.stringify(tampered));
    assert.equal(
      (await host.raw("import_evidence_bundle", { path })).isError,
      true,
    );
    assert.deepEqual(
      (await host.call("get_evidence_bundle")).records.map(
        (item) => item.evidence_id,
      ),
      legacy.records.map((item) => item.evidence_id),
    );
  } finally {
    await host.close();
  }
});

test("App comparisons preserve finite equality, differences, unknown coverage and source authentication", async () => {
  const host = await connected();
  try {
    const left = browserCapture({ identity: "original@1" });
    for (const [right, expected, proof] of [
      [browserCapture(), "unchanged", "pass"],
      [browserCapture({ text: "changed" }), "changed", "fail"],
      // Artifact equality is distinct from replay-environment proof eligibility.
      [browserCapture({ width: 900 }), "unchanged", "unknown"],
      [browserCapture({ missing: true }), "unknown", "unknown"],
    ]) {
      const reply = await host.raw("compare_browser_scenario_evidence", {
        left,
        right,
      });
      assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
      const comparison = reply.structuredContent;
      assert.equal(comparison.normalized_result.overall_status, expected);
      assert.equal(comparison.authority, "analyst-inference");
      assert.deepEqual(
        recomputeBrowserScenarioComparison(comparison, [left, right]),
        comparison.normalized_result,
      );
      assert.equal(
        browserReplayEnvironmentCompatible([left, right]),
        left.parameters.environment.viewport.width ===
          right.parameters.environment.viewport.width,
      );
      const specification = {
        name: "Finite simulated DOM case",
        claims: [
          {
            claim_id: "dom-case",
            title: "DOM equality",
            kind: "browser-behavior",
            dimension: "overall",
            comparison_evidence_id: comparison.evidence_id,
          },
        ],
      };
      const verified = verifyReconstruction(
        specification,
        createEvidenceBundle([left, right, comparison]),
      );
      assert.equal(verified.status, proof, JSON.stringify(verified));
      assert.throws(() => recomputeBrowserScenarioComparison(comparison, []));
      if (expected === "changed") {
        // Even a digest-valid fabricated pass must fail deterministic replay.
        const forged = createEvidence(undefined, comparison.provider, {
          operation: comparison.operation,
          predicateType: comparison.predicate_type,
          parameters: comparison.parameters,
          result: {
            ...comparison.normalized_result,
            overall_status: "unchanged",
          },
          confidence: "derived",
          authority: "analyst-inference",
          evidenceLinks: comparison.evidence_links,
        });
        assert.throws(() =>
          recomputeBrowserScenarioComparison(forged, [left, right]),
        );
        assert.throws(() =>
          verifyReconstruction(
            {
              ...specification,
              claims: [
                {
                  ...specification.claims[0],
                  comparison_evidence_id: forged.evidence_id,
                },
              ],
            },
            createEvidenceBundle([left, right, forged]),
          ),
        );
      }
    }
    const tampered = structuredClone(left);
    tampered.normalized_result.duration_ms += 1;
    assert.equal(
      (
        await host.raw("compare_browser_scenario_evidence", {
          left: tampered,
          right: left,
        })
      ).isError,
      true,
    );
  } finally {
    await host.close();
  }
});

test("feature-bound internal edits use current revisions without checkpoint-induced conflicts", async () => {
  let requests = 0;
  const engine = {
    models: { analyst: "fixture/a", reviewer: null },
    generate: async (request) => {
      const ctx = JSON.parse(request.context);
      requests++;
      assert.ok(
        request.tools.some((tool) => tool.name === "read_feature_project"),
      );
      if (requests === 1)
        return receipt({
          kind: "tool",
          name: "read_feature_project",
          arguments: {},
        });
      if (requests === 2)
        return receipt({
          kind: "tool",
          name: "revise_feature_project",
          arguments: {
            expected_revision:
              ctx.latest_observation.normalized_result.revision,
            changes: { notes: ["Updated by the internal agent"] },
          },
        });
      assert.notEqual(ctx.latest_observation.operation, "local_tool_failure");
      return report(ctx);
    },
  };
  const host = await connected(engine);
  try {
    const created = await host.call("create_feature_project", {
      title: "Internal feature",
      goal: "Update a feature without client analysis calls",
      original: {
        kind: "artifact",
        location: "C:/fixture/input.bin",
        sha256: null,
      },
      candidate: null,
      evidence_bundle: createEvidenceBundle([]),
      obligations: {
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      },
      specification: null,
      cases: [],
      notes: [],
    });
    const started = await host.call("start_investigation", {
      question: "Update the feature notes",
      workspace: host.root,
      feature: {
        project_id: created.project_id,
        expected_revision: created.revision,
      },
    });
    const value = await terminal(host, started.run_id);
    assert.equal(value.state, "completed", JSON.stringify(value.limitations));
    const read = await host.call("read_feature_project", {
      project_id: created.project_id,
    });
    assert.deepEqual(read.project.definition.notes, [
      "Updated by the internal agent",
    ]);
    assert.equal(read.project.jobs[0].state, "completed");
  } finally {
    await host.close();
  }
});
