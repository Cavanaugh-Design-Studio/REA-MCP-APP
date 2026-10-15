import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";

// Real public capture/compare/verification exercise. No simulated browser or AI.
const executable = process.argv[2];
if (!executable)
  throw new Error(
    "Supply an absolute installed Chromium/Chrome/Edge executable path",
  );
const output = resolve(
  process.argv[3] ?? `.cache/annotation-demo/${Date.now()}`,
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const fixture = resolve("tests/fixtures/annotation-viewer");
const html = await readFile(join(fixture, "viewer.html"));
const reference = await readFile(join(fixture, "reference.js"), "utf8");
const candidate = await readFile(join(fixture, "candidate.js"), "utf8");
const scripts = [
  reference,
  candidate.replaceAll("/ documentState.zoom", "/ 1"),
  candidate,
  reference.replace(
    "Math.round(value * 1000) / 1000",
    "Math.round(value / 10) * 10",
  ),
];
const servers = [];
assert.notEqual(
  scripts[1],
  scripts[2],
  "Seeded coordinate bug must alter the candidate",
);
assert.notEqual(
  scripts[0],
  scripts[3],
  "Version change must alter the reference",
);
const origins = [];
const report = {
  scope: "Source-owned real-browser demonstration; not a model benchmark",
  browser_executable: executable,
  output,
  cases: [],
  held_out: [],
  seeded_failure: null,
  repaired: null,
  changed_version: null,
  public_cli: false,
  public_mcp: false,
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await writeFile(
  join(output, "fixture-identities.json"),
  JSON.stringify(
    { html_sha256: sha(html), scripts_sha256: scripts.map(sha) },
    null,
    2,
  ),
);
const environment = {
  ...getDefaultEnvironment(),
  REA_AI_ENABLED: "false",
  REA_PROJECT_STORE: join(output, "projects.sqlite"),
  REA_MCP_MAX_RESPONSE_BYTES: "33554432",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("scripts/rea.mjs"), "mcp"],
  env: environment,
  stderr: "pipe",
});
const client = new Client({
  name: "feature-workspace-real-browser",
  version: "1",
});
let errors = "";
transport.stderr?.on("data", (chunk) => {
  errors += chunk.toString();
});
try {
  for (const script of scripts) {
    const server = createServer((request, response) => {
      if (request.url !== "/" && request.url !== "/app.js") {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          request.url === "/"
            ? "text/html; charset=utf-8"
            : "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(request.url === "/" ? html : script);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(server);
    origins.push(`http://127.0.0.1:${server.address().port}`);
  }
  await client.connect(transport);
  const catalog = await client.listTools();
  const schemas = new Map(
    catalog.tools.map((tool) => [tool.name, tool.outputSchema]),
  );
  const validator = new Ajv2020({ strict: false, validateFormats: false });
  const call = async (name, args = {}) => {
    const value = await client.callTool({ name, arguments: args });
    if (value.isError) {
      const path = join(output, `failure-${name}-${Date.now()}.json`);
      await writeFile(path, JSON.stringify(value, null, 2));
      throw new Error(
        `${name} failed; complete failure and partial observations retained in ${path}`,
      );
    }
    const schema = schemas.get(name);
    assert(schema, `${name} output schema`);
    assert(validator.validateSchema(schema), `${name} schema dialect`);
    const validate =
      (schema.$id ? validator.getSchema(schema.$id) : undefined) ??
      validator.compile(schema);
    assert(
      validate(value.structuredContent),
      `${name}: ${validator.errorsText(validate.errors)}`,
    );
    return value.structuredContent;
  };
  const click = (id) => ({
    action: "click",
    locator: { kind: "css", selector: `#${id}` },
  });
  const fill = (id, value) => ({
    action: "fill",
    locator: { kind: "css", selector: `#${id}` },
    value: { source: "literal", value: String(value) },
  });
  const cases = [
    {
      id: "zoom",
      title: "Placement at zoom 2",
      actions: [
        fill("zoom", 2),
        click("apply-zoom"),
        fill("x", 200),
        fill("y", 100),
        click("place"),
      ],
      expected: { zoom: 2, rotation: 0, annotations: [{ x: 100, y: 50 }] },
    },
    {
      id: "rotation",
      title: "Rotate and move existing annotation",
      actions: [
        click("place"),
        click("rotate"),
        fill("x", 180),
        fill("y", 100),
        click("move"),
      ],
      expected: { zoom: 1, rotation: 90, annotations: [{ x: 100, y: 60 }] },
    },
    {
      id: "undo-redo",
      title: "Undo and redo a rotation",
      actions: [click("place"), click("rotate"), click("undo"), click("redo")],
      expected: { zoom: 1, rotation: 90, annotations: [{ x: 80, y: 60 }] },
    },
    {
      id: "persistence",
      title: "Save, close, reload and reopen",
      actions: [
        click("place"),
        click("rotate"),
        click("save"),
        click("close"),
        { action: "reload-target" },
        click("reopen"),
      ],
      expected: { zoom: 1, rotation: 90, annotations: [{ x: 80, y: 60 }] },
    },
    {
      id: "invalid-cancel",
      title: "Invalid import and cancelled save preserve saved state",
      actions: [
        click("place"),
        click("save"),
        fill("import", "invalid json"),
        click("import-document"),
        click("cancel-save"),
        click("close"),
        click("reopen"),
      ],
      expected: { zoom: 1, rotation: 0, annotations: [{ x: 80, y: 60 }] },
    },
    {
      id: "version",
      title: "Version-sensitive sub-grid coordinates",
      actions: [fill("x", 83), fill("y", 61), click("place")],
      expected: { zoom: 1, rotation: 0, annotations: [{ x: 83, y: 61 }] },
    },
    {
      id: "holdout",
      title: "Independent zoom and rotation combination",
      actions: [
        fill("zoom", 1.5),
        click("apply-zoom"),
        click("rotate"),
        click("rotate"),
        fill("x", 330),
        fill("y", 210),
        click("place"),
      ],
      expected: { zoom: 1.5, rotation: 180, annotations: [{ x: 100, y: 100 }] },
    },
  ];
  const scenario = (item, origin) => ({
    browser: { mode: "launch", executable_path: executable, headless: true },
    start_url: { url: `${origin}/` },
    actions: item.actions.map((action, index) =>
      action.action === "reload-target"
        ? {
            step_id: `step-${index}`,
            action: "goto",
            destination: { url: `${origin}/` },
            wait_until: "load",
          }
        : { step_id: `step-${index}`, timeout_ms: 10000, ...action },
    ),
    capture: {
      after_each_step: [],
      at_end: ["dom", "accessibility"],
      events: ["page-errors"],
    },
  });
  const captures = new Map();
  async function capture(item, side) {
    const key = `${item.id}-${side}`;
    if (captures.has(key)) return captures.get(key);
    const started = performance.now();
    const selected = scenario(item, origins[side]);
    const result = await call("capture_browser_scenario", selected);
    const record = {
      scenario: selected,
      evidence: result,
      elapsed_ms: performance.now() - started,
    };
    assert.equal(
      record.evidence.normalized_result.completeness.status,
      "complete",
    );
    if (side === 0 || side === 2) {
      const text =
        record.evidence.normalized_result.steps.at(-1).artifacts.dom.value.text;
      const match = text.match(/<pre[^>]*id="semantic"[^>]*>([^<]*)<\/pre>/u);
      assert(match, "Semantic document state must be captured");
      assert.deepEqual(
        JSON.parse(match[1]),
        { format: 1, ...item.expected },
        `${item.id} independent expected outcome`,
      );
    }
    captures.set(key, record);
    await writeFile(
      join(output, `${key}.json`),
      JSON.stringify(record, null, 2),
    );
    return record;
  }
  async function exercise(side) {
    const claims = [],
      bindings = [],
      required = [],
      selectedCases = [];
    for (const item of cases) {
      const left = await capture(item, 0),
        right = await capture(item, side);
      const compared = await call("compare_browser_scenario_evidence", {
        left: left.evidence,
        right: right.evidence,
        origin_pair: { before_origin: origins[0], after_origin: origins[side] },
        normalization: {
          rules: [
            {
              rule_id: "selected-origin",
              artifacts: ["action_state", "accessibility", "dom"],
              match: origins[0],
              replacement: origins[side],
            },
          ],
        },
      });
      const obligation = `annotation.${item.id}`;
      claims.push({
        claim_id: item.id,
        title: item.title,
        kind: "browser-behavior",
        dimension: "overall",
        comparison_evidence_id: compared.evidence_id,
      });
      selectedCases.push({
        case_id: item.id,
        title: item.title,
        obligation_ids: [obligation],
        claim_ids: [item.id],
        case_kind: "positive",
        original: { kind: "browser", input: left.scenario },
        candidate: { kind: "browser", input: right.scenario },
      });
      required.push({
        obligation_id: obligation,
        obligation_version: 1,
        title: item.title,
        application_layer: "application",
        family: "annotation",
        target: {
          artifact_sha256: null,
          application_node_id: null,
          semantic_node_id: null,
          location: `${origins[0]}/`,
        },
        required: true,
        required_case_kinds: ["positive"],
        required_original_authority: "runtime",
        required_fixture_authority: "renderer",
        required_verifier_authority: "renderer",
        requires_parser_type: false,
        dependency_obligation_ids: [],
        residual_unknown_ids: [],
        unavailable_authority: [],
        required_next_evidence: [],
        disposition: "active",
        review_evidence_ids: [left.evidence.evidence_id],
      });
      bindings.push({
        obligation_id: obligation,
        owner: {
          module_path: join(fixture, "candidate.js"),
          symbol: "selectedPoint",
          owner_sha256: sha(scripts[side]),
        },
        parser_type: null,
        original_cases: [
          {
            kind: "positive",
            evidence_id: left.evidence.evidence_id,
            location: keyPath(item.id, 0),
          },
        ],
        fixtures: [
          {
            fixture_id: `annotation.${item.id}`,
            case_kind: "positive",
            authority: "renderer",
            evidence_ids: [right.evidence.evidence_id],
          },
        ],
        verifier: null,
      });
      report.cases.push({
        case_id: item.id,
        side,
        comparison: compared.normalized_result.overall_status,
        left_ms: left.elapsed_ms,
        right_ms: right.elapsed_ms,
      });
      process.stdout.write(
        `${item.id} side ${side}: ${compared.normalized_result.overall_status}\n`,
      );
    }
    const specification = { name: "Annotation finite feature", claims };
    const verified = await call("verify_reconstruction", {
      specification,
    });
    for (const binding of bindings)
      binding.verifier = {
        verifier_id: `verify.${binding.obligation_id}`,
        claim_id: claims.find(
          (claim) => `annotation.${claim.claim_id}` === binding.obligation_id,
        ).claim_id,
        command: "rea:browser-scenario-equality",
        authority: "renderer",
        status: verified.normalized_result.status,
        result_evidence_id: verified.evidence_id,
        enumerated_obligation_ids: [binding.obligation_id],
        nondeterminism: {
          mode: "total-order",
          specification:
            "Explicit ordered UI actions, semantic document state and retained DOM/accessibility",
        },
      };
    const finalBundle = (await call("get_evidence_bundle")).result;
    return {
      title: "Annotation behavior",
      goal: "Reproduce annotation transforms, history and persistence with finite executed proof",
      original: { kind: "browser", location: `${origins[0]}/`, sha256: null },
      candidate: {
        kind: "browser",
        location: `${origins[side]}/`,
        sha256: null,
      },
      evidence_bundle: finalBundle,
      obligations: {
        reviewed_obligations: required,
        manifest: { bindings, contradictions: [] },
      },
      specification,
      cases: selectedCases,
      notes: [
        report.scope,
        "Reference source and oracle must be withheld from benchmark reconstruction agents. This demonstration was constructed by the same implementation agent and is not a blind reconstruction.",
      ],
      implementation: {
        launch_instructions: [
          "From the handoff's candidate directory, run node serve.mjs. Open the displayed loopback URL. No dependency installation is required.",
          "Re-run the exported cases with the displayed candidate URL and a separately scoped reference target; old capture URLs identify their original observations.",
        ],
        files: [
          {
            path: "index.html",
            content: html.toString("utf8"),
            sha256: sha(html),
          },
          {
            path: "app.js",
            content: scripts[side],
            sha256: sha(scripts[side]),
          },
          ...(() => {
            const content = `import { createServer } from 'node:http';\nimport { readFile } from 'node:fs/promises';\nconst server = createServer(async (req, res) => { const file = req.url === '/' ? 'index.html' : req.url === '/app.js' ? 'app.js' : null; if (!file) { res.writeHead(404); res.end(); return; } try { const bytes = await readFile(new URL(file, import.meta.url)); res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(bytes); } catch { res.writeHead(500); res.end(); } });\nserver.listen(0, '127.0.0.1', () => process.stdout.write('http://127.0.0.1:' + server.address().port + '/\\n'));\n`;
            return [{ path: "serve.mjs", content, sha256: sha(content) }];
          })(),
        ],
      },
    };
  }
  function keyPath(id, side) {
    return join(output, `${id}-${side}.json`);
  }
  const seeded = await exercise(1);
  const created = (await call("create_feature_project", seeded)).result;
  const failure = (
    await call("read_feature_project", { project_id: created.project_id })
  ).result;
  assert.equal(failure.verification.status, "fail");
  report.seeded_failure = failure.verification.summary;
  const repaired = await exercise(2);
  const revised = (
    await call("revise_feature_project", {
      project_id: created.project_id,
      expected_revision: created.revision,
      definition: repaired,
    })
  ).result;
  const inspection = (
    await call("read_feature_project", { project_id: created.project_id })
  ).result;
  assert.equal(inspection.verification.status, "pass");
  assert.equal(inspection.readiness.state, "ready");
  assert.equal(inspection.proofs.length, 1);
  report.readiness = inspection.readiness;
  report.canonical_ledger = inspection.ledger.normalized_result;
  await writeFile(
    join(output, "feature-inspection.json"),
    JSON.stringify(inspection, null, 2),
  );
  report.repaired = inspection.verification.summary;
  assert.equal(
    (
      await call("read_feature_project", {
        project_id: created.project_id,
        revision: 1,
      })
    ).result.verification.status,
    "fail",
  );
  const stale = await client.callTool({
    name: "revise_feature_project",
    arguments: {
      project_id: created.project_id,
      expected_revision: 1,
      definition: repaired,
    },
  });
  assert.equal(stale.isError, true);
  await call("export_feature_handoff", {
    project_id: created.project_id,
    revision: revised.revision,
    output_directory: join(output, "handoff"),
  });
  const exportedInput = JSON.parse(
    await readFile(join(output, "handoff", "ledger-input.json"), "utf8"),
  );
  const reproduced = await call(
    "build_reconstruction_obligation_ledger",
    exportedInput,
  );
  assert.equal(
    reproduced.normalized_result.closure_digest,
    inspection.ledger.normalized_result.closure_digest,
  );
  report.exported_ledger_reproduced = true;
  const changed = await capture(
    cases.find((item) => item.id === "version"),
    3,
  );
  const unchanged = captures.get("version-0");
  const versionDiff = await call("compare_browser_scenario_evidence", {
    left: unchanged.evidence,
    right: changed.evidence,
    origin_pair: { before_origin: origins[0], after_origin: origins[3] },
    normalization: {
      rules: [
        {
          rule_id: "selected-origin",
          artifacts: ["action_state", "accessibility", "dom"],
          match: origins[0],
          replacement: origins[3],
        },
      ],
    },
  });
  assert.equal(versionDiff.normalized_result.overall_status, "changed");
  report.changed_version = versionDiff.normalized_result.overall_status;
  const execute = promisify(execFile);
  await client.close();
  const cli = await execute(
    process.execPath,
    [
      resolve("scripts/rea.mjs"),
      "read-feature-project",
      JSON.stringify({ project_id: created.project_id }),
      "--json",
    ],
    { env: { ...process.env, ...environment }, maxBuffer: 32 * 1024 * 1024 },
  );
  const cliRead = JSON.parse(cli.stdout);
  assert.equal(cliRead.result.project.project_id, created.project_id);
  assert.equal(cliRead.result.readiness.state, inspection.readiness.state);
  assert.deepEqual(
    cliRead.result.verification.summary,
    inspection.verification.summary,
  );
  report.public_cli = true;
  report.public_mcp = true;
  report.project_id = created.project_id;
  report.revision = revised.revision;
  report.held_out.push({
    case_id: "holdout",
    scope:
      "Independent expected value check within this transparent demonstrator; not withheld from its implementation agent",
    status: "pass",
  });
  await writeFile(
    join(output, "verification-report.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(
    JSON.stringify({
      output,
      project_id: created.project_id,
      repaired: report.repaired,
      readiness: inspection.readiness.state,
      changed_version: report.changed_version,
      public_cli: true,
      public_mcp: true,
    }) + "\n",
  );
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await writeFile(
    join(output, "verification-report.json"),
    JSON.stringify(report, null, 2),
  );
  throw error;
} finally {
  await client.close();
  await transport.close();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  if (errors) await writeFile(join(output, "mcp-stderr.log"), errors);
}
