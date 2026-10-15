import { describe, expect, it } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import type { AgentDecision } from "../../domain/agentInvestigation.js";
import type { AgentEngine } from "./AgentEngine.js";
import { InvestigationCoordinator } from "./InvestigationCoordinator.js";

const evidence = createEvidence(
  undefined,
  { id: "fixture", name: "Fixture", version: "1" },
  {
    operation: "fixture",
    parameters: {},
    result: { value: 'explicit-secret"value' },
  },
);
const report: AgentDecision = {
  kind: "report",
  findings: [
    {
      claim: "Interpretation",
      evidence_ids: [evidence.evidence_id],
      assumptions: ["Static evidence only"],
    },
  ],
  unknowns: ["Runtime behavior"],
  next_steps: ["Collect an observation"],
};
const input = {
  question: "Explain",
  sources: [{ kind: "inline-evidence", evidence }],
  review: false,
};
const engine = (
  decide: (
    request: Parameters<AgentEngine["generate"]>[0],
  ) => Promise<AgentDecision>,
): AgentEngine => ({
  models: { analyst: "test/analyst", reviewer: "test/reviewer" },
  generate: async (request) =>
    ok({
      decision: await decide(request),
      requestedModel: `test/${request.role}`,
      returnedModel: null,
      provider: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }),
});
const tools = {
  resolve: () => undefined,
  withScope: async <T>(
    _signal: AbortSignal,
    _sources: readonly unknown[],
    run: (
      execute: () => Promise<ReturnType<typeof ok<typeof evidence>>>,
    ) => Promise<T>,
  ) => ok(await run(async () => ok(evidence))),
};
async function finish(coordinator: InvestigationCoordinator, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = coordinator.read(id);
    if (!result.ok) throw result.error;
    if (result.value.state !== "running") return result.value;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Fixture run did not finish");
}
const start = (coordinator: InvestigationCoordinator, raw: unknown = input) => {
  const result = coordinator.start(raw);
  if (!result.ok) throw result.error;
  return result.value.run_id;
};

describe("delegated investigation ownership", () => {
  it("aborts and drains sibling requests after worker failure without relabeling it as cancellation", async () => {
    let entered = 0,
      release: () => void = () => {},
      siblingDrained = false;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        const role = JSON.parse(request.context).role;
        if (++entered === 2) release();
        await barrier;
        if (role === "planner")
          return {
            ...report,
            findings: [
              {
                ...report.findings[0]!,
                evidence_ids: [`ev_${"b".repeat(64)}`],
              },
            ],
          };
        if (!request.signal.aborted)
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        siblingDrained = true;
        return report;
      }),
      tools,
    );
    const id = start(coordinator, {
      ...input,
      specialists: ["planner", "behavior-analyst"],
    });
    await barrier;
    await finish(coordinator, id);
    await coordinator.close();
    expect(siblingDrained).toBe(true);
    expect(coordinator.read(id)).toMatchObject({
      ok: true,
      value: { state: "failed", phase: "finished" },
    });
  });
  it("runs independent specialists over immutable starting evidence while serializing and sharing concurrent probes", async () => {
    let arrived = 0,
      release: () => void = () => {},
      operations = 0,
      active = 0,
      maximum = 0;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const perRole = new Map<string, number>();
    const contexts: Record<string, unknown>[] = [];
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        const context = JSON.parse(request.context) as Record<string, unknown>;
        contexts.push(context);
        const role = String(context.role),
          calls = perRole.get(role) ?? 0;
        perRole.set(role, calls + 1);
        if (
          ["planner", "static-analyst", "behavior-analyst"].includes(role) &&
          calls === 0
        ) {
          if (++arrived === 3) release();
          await barrier;
          return {
            kind: "tool",
            name: "inspect_analysis_view",
            arguments: {
              source: {
                kind: "retained-evidence",
                evidence_id: evidence.evidence_id,
              },
              view: { kind: "summary" },
            },
          };
        }
        return report;
      }),
      {
        ...tools,
        withScope: async (_signal, _sources, run) =>
          ok(
            await run(async () => {
              operations += 1;
              maximum = Math.max(maximum, ++active);
              await new Promise<void>((resolve) => setTimeout(resolve, 1));
              active -= 1;
              return ok(evidence);
            }),
          ),
      },
    );
    try {
      const finished = await finish(
        coordinator,
        start(coordinator, {
          ...input,
          specialists: ["planner", "static-analyst", "behavior-analyst"],
          review: true,
          budget: { max_requests: 8 },
        }),
      );
      expect(finished.state).toBe("completed");
      expect(arrived).toBe(3);
      expect(operations).toBe(1);
      expect(maximum).toBe(1);
      expect(
        contexts
          .slice(0, 3)
          .every((context) => (context.specialists as unknown[]).length === 0),
      ).toBe(true);
      expect(finished.specialists.map((item) => item.role)).toEqual([
        "planner",
        "static-analyst",
        "behavior-analyst",
      ]);
      expect(finished.generations).toHaveLength(8);
    } finally {
      await coordinator.close();
    }
  });
});
describe("delegated investigation contracts", () => {
  it("shares one request budget across specialists, synthesis and review, with checkpoints before dispatch", async () => {
    const contexts: Record<string, unknown>[] = [];
    const checkpoints: number[] = [];
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        contexts.push(JSON.parse(request.context));
        return report;
      }),
      tools,
      (run) => {
        checkpoints.push(run.generations.length);
        return ok(undefined);
      },
    );
    try {
      const id = start(coordinator, {
        ...input,
        review: true,
        specialists: ["planner", "static-analyst", "behavior-analyst"],
        budget: { max_requests: 5 },
      });
      const finished = await finish(coordinator, id);
      expect(finished.state).toBe("completed");
      expect(finished.generations.map((item) => item.role)).toEqual([
        "planner",
        "static-analyst",
        "behavior-analyst",
        "analyst",
        "reviewer",
      ]);
      expect(finished.specialists).toHaveLength(3);
      expect(contexts[3]?.specialists).toHaveLength(3);
      expect(checkpoints).toContain(5);
      expect(
        coordinator.start({
          ...input,
          specialists: ["planner", "behavior-analyst"],
          budget: { max_requests: 2 },
        }).ok,
      ).toBe(false);
    } finally {
      await coordinator.close();
    }
  });
  it("denies native function dispatch to a behavior specialist even when the analyst has that authority", async () => {
    let calls = 0;
    const coordinator = new InvestigationCoordinator(
      engine(async () => ({
        kind: "tool",
        name: "analyze_function",
        arguments: { procedure: "main" },
      })),
      {
        ...tools,
        withScope: async (_signal, _sources, run) =>
          ok(
            await run(async () => {
              calls += 1;
              return ok(evidence);
            }),
          ),
      },
    );
    try {
      const id = start(coordinator, {
        ...input,
        allow_function_analysis: true,
        specialists: ["behavior-analyst"],
      });
      expect((await finish(coordinator, id)).state).toBe("failed");
      expect(calls).toBe(0);
    } finally {
      await coordinator.close();
    }
  });
  it("returns separately attributed analyst and reviewer reports without promoting interpretations", async () => {
    const roles: string[] = [];
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        roles.push(request.role);
        return report;
      }),
      tools,
    );
    const result = await finish(
      coordinator,
      start(coordinator, { ...input, review: true }),
    );
    expect(roles).toEqual(["analyst", "reviewer"]);
    expect(result).toMatchObject({
      state: "completed",
      interpretation: "inferred",
      analyst: { findings: report.findings },
      reviewer: { findings: report.findings },
    });
    expect(result.sources).toHaveLength(1);
    await coordinator.close();
  });
  it("rejects tampered Evidence before any model invocation", () => {
    const coordinator = new InvestigationCoordinator(
      engine(async () => {
        throw new Error("Must not run");
      }),
      tools,
    );
    expect(
      coordinator.start({
        ...input,
        sources: [
          {
            kind: "inline-evidence",
            evidence: { ...evidence, normalized_result: { forged: true } },
          },
        ],
      }).ok,
    ).toBe(false);
  });
  it("rejects citations that were never supplied", async () => {
    const coordinator = new InvestigationCoordinator(
      engine(async () => ({
        ...report,
        findings: [
          { ...report.findings[0]!, evidence_ids: [`ev_${"b".repeat(64)}`] },
        ],
      })),
      tools,
    );
    expect((await finish(coordinator, start(coordinator))).state).toBe(
      "failed",
    );
    await coordinator.close();
  });
  it("refuses out-of-scope tool requests and preserves source observations", async () => {
    const coordinator = new InvestigationCoordinator(
      engine(async () => ({
        kind: "tool",
        name: "analyze_function",
        arguments: { procedure: "main" },
      })),
      tools,
    );
    const result = await finish(coordinator, start(coordinator));
    expect(result.state).toBe("failed");
    expect(result.sources[0]).toEqual(evidence);
    await coordinator.close();
  });
});
describe("investigation resource budgets and cancellation", () => {
  it("drains pending siblings while retaining request exhaustion as limited", async () => {
    let entered = 0,
      release: () => void = () => {},
      siblingDrained = false;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        const role = JSON.parse(request.context).role;
        if (++entered === 2) release();
        await barrier;
        if (role === "planner")
          return {
            kind: "tool",
            name: "inspect_analysis_view",
            arguments: {
              source: {
                kind: "retained-evidence",
                evidence_id: evidence.evidence_id,
              },
              view: { kind: "summary" },
            },
          };
        if (!request.signal.aborted)
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        siblingDrained = true;
        return report;
      }),
      tools,
    );
    const id = start(coordinator, {
      ...input,
      specialists: ["planner", "behavior-analyst"],
      budget: { max_requests: 3 },
    });
    await barrier;
    await finish(coordinator, id);
    await coordinator.close();
    expect(siblingDrained).toBe(true);
    expect(coordinator.read(id)).toMatchObject({
      ok: true,
      value: { state: "limited", phase: "finished" },
    });
  });
});
describe("investigation budget admission and inputs", () => {
  it("stops before inference when selected context exceeds the caller budget", async () => {
    let calls = 0;
    const coordinator = new InvestigationCoordinator(
      engine(async () => {
        calls++;
        return report;
      }),
      tools,
    );
    const result = await finish(
      coordinator,
      start(coordinator, { ...input, budget: { max_context_bytes: 1 } }),
    );
    expect(result.state).toBe("limited");
    expect(calls).toBe(0);
    await coordinator.close();
  });
  it("reserves a reviewer request and reports budget exhaustion as incomplete", async () => {
    const coordinator = new InvestigationCoordinator(
      engine(async () => ({
        kind: "tool",
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: evidence.evidence_id,
          },
          view: { kind: "summary" },
        },
      })),
      tools,
    );
    const result = await finish(
      coordinator,
      start(coordinator, {
        ...input,
        review: true,
        budget: { max_requests: 2 },
      }),
    );
    expect(result.state).toBe("limited");
    expect(result.generations).toHaveLength(1);
    expect(result.reviewer).toBeNull();
    await coordinator.close();
  });
  it("cancels owned work and waits for it to settle before closing", async () => {
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return report;
      }),
      tools,
    );
    const id = start(coordinator);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    coordinator.cancel(id);
    await coordinator.close();
    const result = coordinator.read(id);
    expect(result.ok && result.value.state).toBe("cancelled");
    expect(coordinator.start(input).ok).toBe(false);
  });
  it("refuses unavailable engines and missing retained references", () => {
    expect(new InvestigationCoordinator(undefined, tools).start(input).ok).toBe(
      false,
    );
    expect(
      new InvestigationCoordinator(
        engine(async () => report),
        tools,
      ).start({
        ...input,
        sources: [
          { kind: "retained-evidence", evidence_id: evidence.evidence_id },
        ],
      }).ok,
    ).toBe(false);
  });
  it("redacts explicitly marked escaped values while preserving local Evidence", async () => {
    const contexts: string[] = [];
    const coordinator = new InvestigationCoordinator(
      engine(async (request) => {
        contexts.push(request.context);
        return report;
      }),
      tools,
    );
    const result = await finish(
      coordinator,
      start(coordinator, {
        ...input,
        sensitive_values: ['explicit-secret"value'],
      }),
    );
    expect(JSON.parse(contexts[0]!).sources[0].normalized_result.value).toBe(
      "[REDACTED]",
    );
    expect(result.sources[0]?.normalized_result).toEqual({
      value: 'explicit-secret"value',
    });
    expect(result.generations[0]?.context_sha256).toMatch(/^[a-f0-9]{64}$/);
    await coordinator.close();
  });
});
