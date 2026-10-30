import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createApp } from "../dist/server.js";
import { configuredTelemetry } from "../dist/telemetry.js";
import { analysisEnvironment } from "../dist/analysis/environment.js";
import { ok, err } from "../dist/retained/domain/result.js";
import { AnalysisProtocolError, AnalysisCancelledError } from "../dist/retained/domain/analysisErrorCore.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function terminal(app, id) {
  for (let i = 0; i < 300; i++) {
    const result = app.runs.read(id);
    assert.equal(result.ok, true);
    if (result.value.phase === "finished") return result.value;
    await pause(10);
  }
  throw new Error("Investigation did not settle");
}
const attributes = (items = []) => Object.fromEntries(items.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.doubleValue]));

test("telemetry is disabled by default and requires an explicit valid destination", async () => {
  const disabled = await configuredTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" });
  assert.equal(disabled.enabled, false);
  disabled.sync("evidence.retain", () => {});
  await disabled.close();
  for (const endpoint of [undefined, "file:///secret", "https://user:secret@example.test", "https://example.test?secret=1"]) {
    await assert.rejects(configuredTelemetry({ REA_OTEL_ENABLED: "true", REA_OTEL_ENDPOINT: endpoint }), /REA_OTEL_ENDPOINT/);
  }
  assert.deepEqual(analysisEnvironment({ REA_OTEL_ENDPOINT: "secret", OTEL_EXPORTER_OTLP_HEADERS: "secret", OPENROUTER_API_KEY: "secret", PATH: "allowed" }), { PATH: "allowed" });
});

test("real OTLP export traces execution and cancellation without exporting caller data", async () => {
  const requests = [];
  const collector = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  await mkdir(".cache/tests", { recursive: true });
  const root = await mkdtemp(resolve(".cache/tests/telemetry-"));
  const sentinel = "DO_NOT_EXPORT_SECRET_ARTIFACT";
  const target = join(root, `${sentinel}.txt`);
  await writeFile(target, sentinel);
  let cancellationEntered;
  const entered = new Promise((resolve) => { cancellationEntered = resolve; });
  let drained = false;
  let normalRequests = 0;
  const engine = {
    models: { analyst: sentinel, reviewer: null },
    async generate(request) {
      const context = JSON.parse(request.context);
      if (context.question.startsWith("failure")) return err(new AnalysisProtocolError(sentinel));
      if (context.question.startsWith("cancel")) {
        cancellationEntered();
        if (!request.signal.aborted) await once(request.signal, "abort");
        await pause(20);
        drained = true;
        return err(new AnalysisCancelledError(sentinel));
      }
      const first = ++normalRequests === 1;
      return ok({
        decision: first ? { kind: "tool", name: "read_file", arguments: { path: context.target } } : {
          kind: "report", report: { findings: [], unknowns: [sentinel], next_steps: [] },
        },
        requestedModel: sentinel, returnedModel: sentinel, provider: sentinel,
        inputTokens: first ? 5 : null, outputTokens: first ? 2 : null, costUsd: null,
      });
    },
  };
  const app = await createApp({ engine, environment: {
    REA_PROJECT_STORE: join(root, "projects.sqlite"),
    REA_OTEL_ENABLED: "true", REA_OTEL_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
    OPENROUTER_API_KEY: sentinel,
  } });
  try {
    const start = (question) => {
      const result = app.runs.start({ question: `${question} ${sentinel}`, target, workspace: root, review: false });
      assert.equal(result.ok, true);
      return result.value.run_id;
    };
    const completed = await terminal(app, start("inspect"));
    assert.equal(completed.state, "completed", JSON.stringify(completed.limitations));
    assert.ok(completed.sources.some((source) => source.operation === "read_local_file"));
    const failed = await terminal(app, start("failure"));
    assert.equal(failed.state, "failed");
    const cancelledId = start("cancel");
    await entered;
    app.runs.cancel(cancelledId);
    assert.equal((await terminal(app, cancelledId)).state, "cancelled");
    await app.runs.close();
    assert.equal(drained, true);
    await app.telemetry.flush();
    const spans = requests.flatMap(({ body }) => (body.resourceSpans ?? []).flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    for (const name of ["investigation", "model.request", "analysis.call", "evidence.retain", "cancellation"])
      assert.ok(spans.some((s) => s.name === `rea.${name}`), `${name}; received ${JSON.stringify(requests.map((r) => ({ path: r.path, keys: Object.keys(r.body) })))}`);
    const roots = spans.filter((s) => s.name === "rea.investigation");
    assert.deepEqual(roots.map((s) => attributes(s.attributes)["rea.outcome"]).sort(), ["cancelled", "completed", "failed"]);
    for (const span of spans.filter((s) => s.name !== "rea.investigation")) {
      const parent = roots.find((root) => root.spanId === span.parentSpanId && root.traceId === span.traceId);
      assert.ok(parent, `Missing investigation parent for ${span.name}`);
    }
    assert.ok(spans.some((s) => s.name === "rea.model.request" && attributes(s.attributes)["rea.outcome"] === "error"));
    const metrics = requests.flatMap(({ body }) => (body.resourceMetrics ?? []).flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics)));
    const tokens = metrics.find((m) => m.name === "rea.model.tokens");
    assert.equal(tokens.sum.dataPoints.reduce((sum, point) => sum + Number(point.asDouble ?? point.asInt), 0), 7);
    assert.equal(metrics.some((m) => m.name === "rea.model.cost"), false, "Unknown cost must not become zero");
    const serialized = JSON.stringify(requests);
    for (const secret of [sentinel, root, target, completed.run_id, ...completed.sources.map((s) => s.evidence_id)])
      assert.equal(serialized.includes(secret), false, "Sensitive data entered telemetry");
    assert.ok(requests.some((r) => r.path === "/v1/traces"));
    assert.ok(requests.some((r) => r.path === "/v1/metrics"));
  } finally {
    await app.close();
    collector.closeAllConnections();
    await new Promise((resolve) => collector.close(resolve));
  }
});

test("a nonresponsive collector cannot block shutdown or change operation results", async () => {
  const collector = createServer(() => {});
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const telemetry = await configuredTelemetry({
    REA_OTEL_ENABLED: "true", REA_OTEL_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
  });
  try {
    const value = telemetry.sync("evidence.retain", () => 42);
    assert.equal(value, 42);
    const started = performance.now();
    await telemetry.close();
    assert.ok(performance.now() - started < 3000, "Telemetry shutdown exceeded its export bound");
    await telemetry.close();
  } finally {
    collector.closeAllConnections();
    await new Promise((resolve) => collector.close(resolve));
  }
});
