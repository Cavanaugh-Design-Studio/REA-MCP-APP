import { createHash, randomUUID } from "node:crypto";
import type { AgentEngine } from "./AgentEngine.js";
import {
  investigationInputSchema,
  type InvestigationInput,
  type InvestigationRun,
  type InvestigationAcknowledgement,
} from "../../domain/agentInvestigation.js";
import { immutableEvidence, type Evidence } from "../../domain/evidence.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { modelContext } from "./modelContext.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";

export interface InvestigationTools {
  resolve(id: string): Evidence | undefined;
  /** Own admission and target identity across the entire investigation, including awaits. */
  withScope<T>(
    signal: AbortSignal,
    sources: readonly Evidence[],
    run: (
      execute: (
        name: "inspect_analysis_view" | "analyze_function",
        args: Readonly<Record<string, JsonValue>>,
      ) => Promise<Result<Evidence, AnalysisError>>,
    ) => Promise<T>,
  ): Promise<Result<T, AnalysisError>>;
}
interface OwnedRun {
  readonly value: InvestigationRun;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

/** Session-owned worker team. Workers cannot acquire target lifecycle or mutate source observations. */
export class InvestigationCoordinator {
  readonly #runs = new Map<string, OwnedRun>();
  #closed = false;
  constructor(
    private readonly engine: AgentEngine | undefined,
    private readonly tools: InvestigationTools,
    private readonly checkpoint?: (
      value: InvestigationRun,
    ) => Result<void, AnalysisError>,
    private readonly onSettled?: (runId: string) => Result<void, AnalysisError>,
  ) {}

  status() {
    return {
      enabled: this.engine !== undefined,
      models: this.engine?.models ?? null,
      runs: [...this.#runs.values()].map(({ value }) => ({
        run_id: value.run_id,
        question: value.question,
        state: value.state,
        phase: value.phase,
      })),
    };
  }

  start(raw: unknown): Result<InvestigationAcknowledgement, AnalysisError> {
    const input = investigationInputSchema.safeParse(raw);
    if (!input.success)
      return err(new AnalysisInputError("start_investigation"));
    if (this.#closed || this.engine === undefined)
      return err(
        new AnalysisCapabilityUnavailableError(
          "reasoning-engine",
          "start_investigation",
          "Cloud inference is disabled. Configure REA_AI_ENABLED=true, OPENROUTER_API_KEY and REA_AI_ANALYST_MODEL on the server.",
        ),
      );
    if (input.data.review && this.engine.models.reviewer === null)
      return err(
        new AnalysisCapabilityUnavailableError(
          "reasoning-engine",
          "start_investigation",
          "A reviewer was requested but REA_AI_REVIEWER_MODEL is not configured. Select review=false or configure a reviewer.",
        ),
      );
    if (
      input.data.budget.max_requests <
      input.data.specialists.length + (input.data.review ? 2 : 1)
    )
      return err(new AnalysisInputError("start_investigation"));
    const sources: Evidence[] = [];
    try {
      for (const source of input.data.sources) {
        const evidence =
          source.kind === "inline-evidence"
            ? source.evidence
            : this.tools.resolve(source.evidence_id);
        if (evidence === undefined)
          return err(
            new AnalysisProtocolError(
              `Missing retained Evidence ${source.kind === "retained-evidence" ? source.evidence_id : ""}`,
            ),
          );
        const sealed = immutableEvidence(evidence);
        if (
          !sources.some(
            (existing) => existing.evidence_id === sealed.evidence_id,
          )
        )
          sources.push(sealed);
      }
    } catch {
      return err(new AnalysisInputError("start_investigation"));
    }
    const value: InvestigationRun = {
      run_id: randomUUID(),
      question: input.data.question,
      state: "running",
      phase: "analyst",
      sources,
      analyst: null,
      reviewer: null,
      specialists: [],
      interpretation: "inferred",
      events: [],
      generations: [],
      limitations: [],
    };
    const controller = new AbortController();
    // Yield once so ownership is registered before any work or cancellation can settle.
    const settled = Promise.resolve().then(() =>
      this.#run(value, input.data, controller),
    );
    this.#runs.set(value.run_id, { value, controller, settled });
    return ok({ run_id: value.run_id, state: value.state, phase: value.phase });
  }

  read(id: string): Result<InvestigationRun, AnalysisError> {
    const run = this.#runs.get(id);
    return run === undefined
      ? err(new AnalysisProtocolError(`Unknown investigation run ${id}`))
      : ok(this.#snapshot(run.value));
  }

  cancel(id: string): Result<InvestigationRun, AnalysisError> {
    const run = this.#runs.get(id);
    if (run === undefined)
      return err(new AnalysisProtocolError(`Unknown investigation run ${id}`));
    run.controller.abort();
    return ok(this.#snapshot(run.value));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const run of this.#runs.values()) run.controller.abort();
    await Promise.all([...this.#runs.values()].map((run) => run.settled));
  }

  #snapshot(value: InvestigationRun): InvestigationRun {
    return {
      ...structuredClone({ ...value, sources: [] }),
      sources: [...value.sources],
    };
  }
  #event(
    value: InvestigationRun,
    role: InvestigationRun["events"][number]["role"],
    message: string,
  ) {
    value.events.push({ sequence: value.events.length, role, message });
    const saved = this.checkpoint?.(this.#snapshot(value));
    if (saved && !saved.ok) throw saved.error;
  }

  async #run(
    value: InvestigationRun,
    input: InvestigationInput,
    controller: AbortController,
  ): Promise<void> {
    const timer = setTimeout(
      () => controller.abort("deadline"),
      input.budget.timeout_ms,
    );
    try {
      const scoped = await this.tools.withScope(
        controller.signal,
        value.sources,
        async (execute) => {
          const roles = [
            ...input.specialists,
            ...(input.review
              ? (["analyst", "reviewer"] as const)
              : (["analyst"] as const)),
          ];
          const toolCache = new Map<
            string,
            Promise<Result<Evidence, AnalysisError>>
          >();
          let providerQueue: Promise<void> = Promise.resolve();
          const requests = new Map(roles.map((role) => [role, 0]));
          const initialSources = [...value.sources];
          const runRole = async (
            role: (typeof roles)[number],
            workerSources: Evidence[],
          ) => {
            try {
              const engineRole = role === "reviewer" ? "reviewer" : "analyst";
              const allowFunctionAnalysis =
                input.allow_function_analysis &&
                (role === "analyst" || role === "static-analyst");
              value.phase = role;
              this.#event(
                value,
                role,
                role === "reviewer"
                  ? "Checking citations and challenging interpretations"
                  : `Investigating as ${role}`,
              );
              while (!controller.signal.aborted && value.state === "running") {
                const reserve = roles.filter(
                  (other) => other !== role && requests.get(other) === 0,
                ).length;
                if (
                  value.generations.length >=
                  input.budget.max_requests - reserve
                ) {
                  value.state = "limited";
                  value.limitations.push(
                    "Caller-selected model request budget reached; investigation is incomplete.",
                  );
                  return;
                }
                const context = modelContext(
                  {
                    question: input.question,
                    feature: input.feature ?? null,
                    role,
                    assignment:
                      role === "planner"
                        ? "Identify unresolved questions and the cheapest adequate next probe. Do not claim execution or verification."
                        : role === "static-analyst"
                          ? "Explain relevant code and data structures using assigned Evidence; preserve unknowns."
                          : role === "behavior-analyst"
                            ? "Explain observed state transitions and propose distinguishing normal, edge and failure cases. Proposals are not executed observations."
                            : "Synthesize the scoped findings and preserve conflicting interpretations.",
                    sources: workerSources,
                    specialists:
                      role === "analyst" || role === "reviewer"
                        ? value.specialists
                        : [],
                    analyst: role === "reviewer" ? value.analyst : null,
                  },
                  input.budget.max_context_bytes,
                  input.sensitive_values,
                );
                if (context === null) {
                  value.state = "limited";
                  value.limitations.push(
                    "Selected evidence exceeds the caller's context byte budget. Select focused analysis views; no evidence was silently truncated.",
                  );
                  return;
                }
                const attempt: InvestigationRun["generations"][number] = {
                  role,
                  context_sha256: createHash("sha256")
                    .update(context)
                    .digest("hex"),
                  source_evidence_ids: workerSources.map(
                    (source) => source.evidence_id,
                  ),
                  requested_model: this.engine!.models[engineRole]!,
                  returned_model: null,
                  provider: null,
                  input_tokens: null,
                  output_tokens: null,
                  cost_usd: null,
                };
                value.generations.push(attempt);
                requests.set(role, requests.get(role)! + 1);
                const persisted = this.checkpoint?.(this.#snapshot(value));
                if (persisted && !persisted.ok) throw persisted.error;
                const generated = await this.engine!.generate({
                  role: engineRole,
                  context,
                  maxOutputTokens: input.budget.max_output_tokens,
                  maxResponseBytes: input.budget.max_response_bytes,
                  signal: controller.signal,
                  allowFunctionAnalysis,
                });
                if (!generated.ok) {
                  if (controller.signal.aborted) return;
                  value.state =
                    generated.error._tag === "AnalysisResourceConstraintError"
                      ? "limited"
                      : "failed";
                  value.limitations.push(generated.error.message);
                  return;
                }
                const generation = generated.value;
                Object.assign(attempt, {
                  returned_model: generation.returnedModel,
                  provider: generation.provider,
                  input_tokens: generation.inputTokens,
                  output_tokens: generation.outputTokens,
                  cost_usd: generation.costUsd,
                });
                if (controller.signal.aborted || value.state !== "running")
                  return;
                const decision = generation.decision;
                if (decision.kind === "failed") {
                  value.state = "failed";
                  value.limitations.push(decision.reason);
                  return;
                }
                if (decision.kind === "limited") {
                  value.state = "limited";
                  value.limitations.push(decision.reason);
                  return;
                }
                if (decision.kind === "report") {
                  const ids = new Set(
                    workerSources.map((source) => source.evidence_id),
                  );
                  if (
                    decision.findings.some((finding) =>
                      finding.evidence_ids.some((id) => !ids.has(id)),
                    )
                  ) {
                    value.state = "failed";
                    value.limitations.push(
                      "Model report cited evidence outside the assigned investigation.",
                    );
                    return;
                  }
                  const { kind: _kind, ...report } = decision;
                  if (role === "analyst" || role === "reviewer")
                    value[role] = report;
                  else value.specialists.push({ role, report });
                  this.#event(
                    value,
                    role,
                    `Returned ${report.findings.length} inferred findings and ${report.unknowns.length} unresolved questions`,
                  );
                  break;
                }
                if (
                  role === "reviewer" ||
                  (decision.name === "analyze_function" &&
                    !allowFunctionAnalysis)
                ) {
                  value.state = "failed";
                  value.limitations.push(
                    "Worker requested an operation outside its delegated authority.",
                  );
                  return;
                }
                if (decision.name === "inspect_analysis_view") {
                  const source = decision.arguments.source;
                  const admittedSource =
                    typeof source === "object" &&
                    source !== null &&
                    !Array.isArray(source) &&
                    source.kind === "retained-evidence" &&
                    typeof source.evidence_id === "string" &&
                    workerSources.some(
                      (item) => item.evidence_id === source.evidence_id,
                    );
                  if (!admittedSource) {
                    value.state = "failed";
                    value.limitations.push(
                      "Worker requested evidence outside its assigned scope.",
                    );
                    return;
                  }
                }
                const cacheKey = digestCanonicalValue([
                  decision.name,
                  decision.arguments,
                ]);
                const cached = toolCache.get(cacheKey);
                let operation = cached;
                if (operation === undefined) {
                  operation = providerQueue.then(() =>
                    controller.signal.aborted || value.state !== "running"
                      ? err(
                          new AnalysisProtocolError(
                            "Investigation stopped before provider dispatch",
                          ),
                        )
                      : execute(decision.name, decision.arguments),
                  );
                  providerQueue = operation.then(
                    () => undefined,
                    () => undefined,
                  );
                  toolCache.set(cacheKey, operation);
                }
                const observed = await operation;
                if (!observed.ok) {
                  if (controller.signal.aborted || value.state !== "running")
                    return;
                  value.state = "failed";
                  value.limitations.push(observed.error.message);
                  return;
                }
                if (
                  !workerSources.some(
                    (source) =>
                      source.evidence_id === observed.value.evidence_id,
                  )
                )
                  workerSources.push(immutableEvidence(observed.value));
                if (
                  !value.sources.some(
                    (source) =>
                      source.evidence_id === observed.value.evidence_id,
                  )
                )
                  value.sources.push(immutableEvidence(observed.value));
                this.#event(
                  value,
                  role,
                  `${cached === undefined ? "Collected" : "Reused"} ${decision.name} evidence`,
                );
              }
            } catch (cause) {
              if (controller.signal.reason !== "worker-stopped")
                value.state = "failed";
              throw cause;
            } finally {
              if (value.state === "failed" || value.state === "limited")
                controller.abort("worker-stopped");
            }
          };
          // Independent specialists receive identical immutable starting Evidence;
          // their reports meet only at synthesis. Provider work remains serialized.
          const settled = await Promise.allSettled(
            input.specialists.map((role) => runRole(role, [...initialSources])),
          );
          const rejected = settled.find((item) => item.status === "rejected");
          if (rejected?.status === "rejected") throw rejected.reason;
          value.specialists.sort(
            (left, right) =>
              input.specialists.indexOf(left.role) -
              input.specialists.indexOf(right.role),
          );
          if (controller.signal.aborted || value.state !== "running") return;
          await runRole("analyst", [...value.sources]);
          if (controller.signal.aborted || value.state !== "running") return;
          if (input.review) await runRole("reviewer", [...value.sources]);
          if (controller.signal.aborted || value.state !== "running") return;
          value.state = "completed";
          value.limitations.push(
            "Model interpretations and reviewer agreement do not establish observed behavior or completeness.",
          );
        },
      );
      if (!scoped.ok) {
        value.state = "failed";
        value.limitations.push(scoped.error.message);
      }
      if (
        controller.signal.aborted &&
        controller.signal.reason !== "worker-stopped"
      ) {
        value.state =
          controller.signal.reason === "deadline" ? "limited" : "cancelled";
        value.limitations.push(
          controller.signal.reason === "deadline"
            ? "Caller-selected investigation deadline reached."
            : "Cancelled; previously collected observations remain available.",
        );
      }
    } catch {
      value.state =
        controller.signal.reason === "worker-stopped"
          ? value.state
          : controller.signal.aborted
            ? controller.signal.reason === "deadline"
              ? "limited"
              : "cancelled"
            : "failed";
      value.limitations.push(
        "Investigation execution failed; collected evidence is retained.",
      );
    } finally {
      clearTimeout(timer);
      value.phase = "finished";
      try {
        this.#event(value, "coordinator", `Investigation ${value.state}`);
      } catch {
        value.state = "failed";
        value.limitations.push(
          "Durable checkpoint failed; completion was not persisted.",
        );
      }
      const released = this.onSettled?.(value.run_id);
      if (released && !released.ok) {
        value.state = "failed";
        value.limitations.push(
          "Durable worker ownership cleanup failed; ownership is retained for retry.",
        );
      }
    }
  }
}
