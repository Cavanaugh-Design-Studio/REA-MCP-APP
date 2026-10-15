import { describe, expect, it } from "vitest";
import { OpenRouterEngine } from "./OpenRouterEngine.js";
import { createEvidence } from "../domain/evidence.js";

const source = createEvidence(
  undefined,
  { id: "fixture", name: "Fixture", version: "1" },
  { operation: "fixture", parameters: {}, result: {} },
);
const report = {
  findings: [
    {
      claim: "Interpretation",
      evidence_ids: [source.evidence_id],
      assumptions: [],
    },
  ],
  unknowns: [],
  next_steps: [],
};
const request = {
  role: "analyst" as const,
  context: "bounded input",
  maxOutputTokens: 2048,
  maxResponseBytes: 1048576,
  signal: new AbortController().signal,
  allowFunctionAnalysis: false,
};
const completion = (message: unknown, finish_reason = "stop") => ({
  model: "returned/model",
  provider: "fixture",
  usage: { prompt_tokens: 11, completion_tokens: 22, cost: 0.01 },
  choices: [{ finish_reason, message }],
});
function fixture(body: unknown, status = 200) {
  let sent: Record<string, unknown> = {};
  const engine = new OpenRouterEngine(
    { analyst: "configured/analyst", reviewer: "configured/reviewer" },
    "server-only-key",
    (async (_url, options) => {
      sent = JSON.parse(String(options?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch,
  );
  return { engine, sent: () => sent };
}
describe("OpenRouter engine boundary (mock HTTP only)", () => {
  it("supports explicitly configured JSON-object conditioning with strict local report validation", async () => {
    let sent: Record<string, unknown> = {};
    const engine = new OpenRouterEngine(
      { analyst: "caller/model", reviewer: null },
      "private-key",
      (async (_url, options) => {
        sent = JSON.parse(String(options?.body));
        return Response.json(completion({ content: JSON.stringify(report) }));
      }) as typeof fetch,
      undefined,
      { analyst: "json-object" },
    );
    expect((await engine.generate(request)).ok).toBe(true);
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.provider).toMatchObject({
      zdr: true,
      data_collection: "deny",
      allow_fallbacks: false,
    });
  });
  it("uses selected models, strict output, ZDR routing and role-specific canonical tools", async () => {
    const { engine, sent } = fixture(
      completion({ content: JSON.stringify(report) }),
    );
    const response = await engine.generate(request);
    expect(response.ok && response.value.decision).toEqual({
      kind: "report",
      ...report,
    });
    expect(sent()).toMatchObject({
      model: "configured/analyst",
      provider: {
        zdr: true,
        data_collection: "deny",
        allow_fallbacks: false,
        require_parameters: true,
      },
      response_format: { type: "json_schema" },
    });
    expect(JSON.stringify(sent())).not.toContain("server-only-key");
    expect(
      (sent().tools as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["inspect_analysis_view"]);
    await engine.generate({ ...request, role: "reviewer" });
    expect(sent().model).toBe("configured/reviewer");
    expect(sent().tools).toBeUndefined();
  });
  it("parses one tool call and preserves output exhaustion as a limited decision with usage", async () => {
    const first = fixture(
      completion({
        tool_calls: [
          {
            type: "function",
            function: {
              name: "inspect_analysis_view",
              arguments: JSON.stringify({
                source: {
                  kind: "retained-evidence",
                  evidence_id: source.evidence_id,
                },
                view: { kind: "summary" },
              }),
            },
          },
        ],
      }),
    );
    const decision = await first.engine.generate(request);
    expect(decision.ok && decision.value.decision.kind).toBe("tool");
    const exhausted = fixture(completion({ content: "unfinished" }, "length"));
    const result = await exhausted.engine.generate(request);
    expect(result.ok && result.value).toMatchObject({
      decision: { kind: "limited" },
      inputTokens: 11,
      outputTokens: 22,
      costUsd: 0.01,
    });
  });
  it("bounds response allocation and never exposes error payloads or credentials", async () => {
    const oversized = await fixture(
      completion({ content: "x".repeat(1000) }),
    ).engine.generate({ ...request, maxResponseBytes: 10 });
    expect(!oversized.ok && oversized.error._tag).toBe(
      "AnalysisResourceConstraintError",
    );
    const denied = await fixture(
      { secret: "private upstream error" },
      401,
    ).engine.generate(request);
    expect(!denied.ok && denied.error.message).toContain("HTTP 401");
    expect(!denied.ok && denied.error.message).not.toContain(
      "private upstream error",
    );
    const malformed = await fixture(
      completion({ content: "not JSON server-only-key" }),
    ).engine.generate(request);
    expect(malformed.ok && malformed.value.decision).toMatchObject({
      kind: "failed",
    });
    expect(malformed.ok && JSON.stringify(malformed.value)).not.toContain(
      "server-only-key",
    );
  });
  it("passes abort to fetch and reports cancellation", async () => {
    const controller = new AbortController();
    const engine = new OpenRouterEngine(
      { analyst: "a", reviewer: null },
      "key",
      (async (_url, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort();
        throw new Error("aborted");
      }) as typeof fetch,
    );
    const result = await engine.generate({
      ...request,
      signal: controller.signal,
    });
    expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
  });
});
