import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp, MODEL_TOOL_NAMES } from "../dist/server.js";
import { BraveSearch } from "../dist/research/BraveSearch.js";
import { planReconstruction } from "../dist/research/ReconstructionPlan.js";
import { researchToolDefinitions } from "../dist/research/contracts.js";
import { analysisToolDefinitions } from "../dist/analysis/contracts.js";
import { localToolDefinitions } from "../dist/contracts.js";
import { createEvidence, parseEvidence } from "../dist/retained/domain/evidence.js";
import { ok } from "../dist/retained/domain/result.js";

const payload = { type: "search", query: { original: "JavaScript string trim documentation" }, web: { results: [
  { title: "String reference fixture", url: "https://example.com/string-reference", description: "Untrusted search reference, not observed application behavior." },
] } };
const json = (value = payload) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const plan = (evidenceIds = []) => ({
  scope: "feature", goal: "Reproduce whitespace normalization",
  features: [{ id: "normalize", behavior: "Trim leading/trailing whitespace and collapse internal whitespace", evidence_ids: evidenceIds, assumptions: ["Only the listed input cases are in scope"] }],
  components: [{ id: "core", responsibility: "Normalize text", feature_ids: ["normalize"], interfaces: ["normalize(text: string): string"], state: [] }],
  cases: [{ id: "spacing", feature_ids: ["normalize"], kind: "positive", input: "Leading, trailing, repeated whitespace, empty and unchanged text", expected: "Exact outputs match original on each selected input" }],
  steps: [
    { id: "verify", action: "Compare exact outputs on both implementations", component_ids: ["core"], feature_ids: ["normalize"], depends_on: ["implement"], case_ids: ["spacing"] },
    { id: "implement", action: "Write candidate module in owned workspace", component_ids: ["core"], feature_ids: ["normalize"], depends_on: [], case_ids: ["spacing"] },
  ], unknowns: ["Unicode, malformed input, performance and full-application equivalence remain unverified"],
});

test("Brave search retains authenticated external Evidence, scopes credentials and limits requests", async () => {
  let calls = 0;
  const search = new BraveSearch("transport-only-secret", async (url, init) => {
    calls++;
    assert.equal(url.origin, "https://api.search.brave.com");
    assert.equal(url.searchParams.get("q"), "JavaScript string trim documentation");
    assert.equal(url.href.includes("transport-only-secret"), false);
    assert.equal(init.headers["X-Subscription-Token"], "transport-only-secret");
    assert.equal(init.redirect, "error");
    return json();
  });
  const signal = new AbortController().signal;
  const allowance = { remaining: 1, sensitiveValues: ["private-source-marker"] };
  await assert.rejects(search.search({ query: "private-source-marker" }, allowance, 65536, signal), /protected sensitive/);
  await assert.rejects(search.search({ query: "transport-only-secret" }, allowance, 65536, signal), /protected sensitive/);
  await assert.rejects(search.search({ query: "public" }, undefined, 65536, signal), /allow_web_search/);
  assert.equal(calls, 0);
  const evidence = await search.search({ query: "JavaScript string trim documentation" }, allowance, 65536, signal);
  assert.equal(parseEvidence(evidence).evidence_id, evidence.evidence_id);
  assert.equal(evidence.authority, "external-service");
  assert.equal(evidence.raw_result.body, JSON.stringify(payload));
  assert.equal(evidence.normalized_result.results[0].url, payload.web.results[0].url);
  assert.ok(Date.parse(evidence.normalized_result.retrieved_at));
  assert.equal(JSON.stringify(evidence).includes("transport-only-secret"), false);
  await assert.rejects(search.search({ query: "public" }, allowance, 65536, signal), /budget reached/);
  await assert.rejects(new BraveSearch(undefined).search({ query: "public" }, { remaining: 1, sensitiveValues: [] }, 65536, signal), /BRAVE_SEARCH_API_KEY/);
  assert.equal(calls, 1);
  const noQueryMetadata = await new BraveSearch("key", async () => json({ ...payload, query: null }))
    .search({ query: "public" }, { remaining: 1, sensitiveValues: [] }, 65536, signal);
  assert.equal(noQueryMetadata.normalized_result.provider_query, null);
});

test("Brave failures, cancellation, unsafe results and oversized bodies never become search facts", async () => {
  const signal = new AbortController().signal;
  const allowance = () => ({ remaining: 1, sensitiveValues: [] });
  for (const [response, message] of [
    [new Response("private-provider-error", { status: 429 }), /HTTP 429/],
    [new Response("not-json"), /invalid response/],
    [json({ ...payload, web: { results: [{ title: "bad", url: "file:///private" }] } }), /invalid response/],
    [new Response("x".repeat(1025)), /byte budget/],
  ]) {
    await assert.rejects(new BraveSearch("key", async () => response).search({ query: "public" }, allowance(), 1024, signal), message);
  }
  const controller = new AbortController();
  const search = new BraveSearch("key", async (_url, init) => {
    controller.abort();
    init.signal.throwIfAborted();
  });
  await assert.rejects(search.search({ query: "public" }, allowance(), 65536, controller.signal), { name: "AbortError" });
});

test("planner preserves inference and rejects unassigned Evidence, dangling coverage and cycles", () => {
  const source = createEvidence(undefined, { id: "fixture", name: "fixture", version: "1" }, { operation: "inspect", parameters: {}, result: {} });
  const value = planReconstruction(plan([source.evidence_id]), [source], 65536);
  assert.equal(parseEvidence(value).evidence_id, value.evidence_id);
  assert.equal(value.confidence, "inferred");
  assert.equal(value.authority, "analyst-inference");
  assert.equal(value.normalized_result.verified, false);
  assert.deepEqual(value.evidence_links, [source.evidence_id]);
  assert.deepEqual(value.normalized_result.implementation_order, ["implement", "verify"]);
  assert.ok(value.normalized_result.acceptance.every((item) => item.state === "not-executed"));
  assert.throws(() => planReconstruction(plan([source.evidence_id]), [], 65536), /outside this investigation/);
  for (const change of [
    (p) => { p.steps[1].depends_on = ["verify"]; },
    (p) => { p.steps[0].component_ids = ["missing"]; },
    (p) => { p.steps[1].id = "verify"; },
    (p) => { p.features.push({ ...p.features[0], id: "uncovered" }); },
    (p) => { p.steps[0].case_ids = ["missing"]; },
  ]) {
    const invalid = plan(); change(invalid);
    assert.throws(() => planReconstruction(invalid, [], 65536));
  }
  assert.throws(() => planReconstruction(plan(), [], 50), /byte budget/);
  assert.equal(MODEL_TOOL_NAMES.length, 4);
  assert.equal(researchToolDefinitions.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify([...localToolDefinitions, ...analysisToolDefinitions, ...researchToolDefinitions])) < 16384);
});

test("one assignment researches, plans, implements and checks a finite feature in its owned workspace", {
  skip: process.platform === "win32" && !existsSync(resolve("native/windows/build/manifest.json")) ? "Verified native process authority unavailable" : false,
}, async () => {
  await mkdir(".cache/tests", { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/reconstruction-"));
  const original = join(root, "original.mjs");
  const content = "export const normalize = (text) => text.trim().replace(/\\s+/g, ' ');\n";
  await writeFile(original, content);
  let turn = 0, searches = 0;
  const engine = {
    models: { analyst: "fixture", reviewer: null },
    async generate(request) {
      const context = JSON.parse(request.context);
      assert.ok(request.tools.some((tool) => tool.name === "plan_reconstruction"));
      assert.ok(request.tools.some((tool) => tool.name === "search_web"));
      let decision;
      switch (turn++) {
        case 0: decision = { kind: "tool", name: "read_file", arguments: { path: context.target } }; break;
        case 1: decision = { kind: "tool", name: "search_web", arguments: { query: "JavaScript string trim documentation" } }; break;
        case 2: decision = { kind: "tool", name: "plan_reconstruction", arguments: plan(context.sources.map((source) => source.evidence_id)) }; break;
        case 3: decision = { kind: "tool", name: "write_file", arguments: { path: "candidate.mjs", content } }; break;
        case 4: decision = { kind: "tool", name: "run_command", arguments: {
          executable: process.execPath, arguments: ["--input-type=module", "-e",
            "import{pathToFileURL}from'node:url';import assert from'node:assert/strict';const a=await import(pathToFileURL(process.argv[1]));const b=await import(pathToFileURL(process.argv[2]));for(const s of['  a   b  ','','unchanged','  '])assert.equal(a.normalize(s),b.normalize(s));console.log(JSON.stringify({cases:4,match:true,braveCredentialPresent:!!process.env.BRAVE_SEARCH_API_KEY}));",
            context.target, join(context.workspace, "candidate.mjs")], timeout_ms: 10000,
        } }; break;
        default: decision = { kind: "report", report: { findings: [], unknowns: ["Only four finite cases were compared"], next_steps: [] } };
      }
      return ok({ decision, requestedModel: "fixture", returnedModel: "fixture", provider: "simulated", inputTokens: null, outputTokens: null, costUsd: null });
    },
  };
  const app = await createApp({ engine, searchFetch: async () => { searches++; return json(); }, environment: {
    REA_PROJECT_STORE: join(root, "projects.sqlite"), BRAVE_SEARCH_API_KEY: "transport-only-secret",
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH ?? process.env.Path,
    TEMP: root, TMP: root,
    ...(process.platform === "win32" ? { REA_WINDOWS_NATIVE_DIR: resolve("native/windows/build") } : {}),
  } });
  try {
    const started = app.runs.start({ question: "Reproduce normalization", target: original, workspace: join(root, "runs"), review: false, allow_web_search: true, max_web_searches: 1 });
    assert.equal(started.ok, true);
    let run;
    for (let i = 0; i < 400; i++) {
      run = app.runs.read(started.value.run_id).value;
      if (run.phase === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(run.state, "completed", JSON.stringify(run.limitations));
    assert.equal(searches, 1);
    const blueprint = run.sources.find((source) => source.operation === "plan_reconstruction");
    assert.equal(blueprint.normalized_result.verified, false);
    assert.equal(blueprint.confidence, "inferred");
    const command = run.sources.find((source) => source.operation === "run_local_command");
    assert.equal(command.normalized_result.exitCode, 0, JSON.stringify(command.normalized_result));
    assert.deepEqual(JSON.parse(command.normalized_result.stdout.text), { cases: 4, match: true, braveCredentialPresent: false });
    assert.equal(command.normalized_result.cleanup, "verified");
    assert.equal(await readFile(original, "utf8"), content);
    assert.equal(JSON.stringify(app.evidence.bundle()).includes("transport-only-secret"), false);
  } finally { await app.close(); }
});
