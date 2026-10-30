import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  taskInputSchema,
  localToolDefinitions,
  type InternalToolName,
  type TaskInput,
} from "./contracts.js";
import type { Engine } from "./ai/Engine.js";
import { LocalTools, type RunWorkspace } from "./localTools.js";
import { EvidenceStore } from "./evidence.js";
import {
  immutableEvidence,
  createEvidence,
  type Evidence,
} from "./retained/domain/evidence.js";
import { modelContext } from "./retained/application/agents/modelContext.js";
import {
  investigationInputSchema,
  type InvestigationRun,
} from "./retained/domain/agentInvestigation.js";
import { FeatureInvestigationBinding } from "./retained/application/features/FeatureInvestigationBinding.js";
import type { FeatureProjectService } from "./retained/application/features/FeatureProjectService.js";
import { compareBrowserScenarioEvidence } from "./retained/application/features/BrowserScenarioComparison.js";
import { createEvidenceBundle } from "./retained/domain/evidenceBundle.js";
import { jsonValueSchema } from "./retained/domain/jsonValue.js";
import { analysisToolDefinitions } from "./analysis/contracts.js";
import { projectAnalysisError } from "./retained/domain/analysisErrorProjection.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
} from "./retained/domain/analysisErrorCore.js";
import type { AnalysisError } from "./retained/domain/analysisErrorBase.js";
import { err, ok, type Result } from "./retained/domain/result.js";
import { Telemetry, type Observation } from "./telemetry.js";
import { researchToolDefinitions } from "./research/contracts.js";

interface OwnedRun {
  value: InvestigationRun;
  input: TaskInput;
  controller: AbortController;
  settled: Promise<void>;
  workspace: RunWorkspace | null;
  observation: Observation;
  cancellation: Observation | null;
}
const legacyInput = (input: TaskInput) =>
  investigationInputSchema.parse({
    question: input.question,
    sources: input.sources,
    review: input.review,
    specialists: input.specialists,
    sensitive_values: input.sensitive_values,
    budget: input.budget,
    ...(input.feature ? { feature: input.feature } : {}),
  });

// Select a context view; never truncate the retained source observation.
const contextObservation = (item: Evidence | undefined, budget: number) => {
  if (!item) return null;
  if (Buffer.byteLength(JSON.stringify(item)) <= Math.floor(budget / 2))
    return item;
  const result = item.normalized_result;
  const summary =
    result && typeof result === "object" && !Array.isArray(result)
      ? {
          collections: Object.fromEntries(
            Object.entries(result)
              .filter(([, value]) => Array.isArray(value))
              .map(([name, value]) => [name, (value as unknown[]).length]),
          ),
          graph:
            "graph" in result &&
            result.graph &&
            typeof result.graph === "object" &&
            !Array.isArray(result.graph)
              ? {
                  nodes: Array.isArray(result.graph.nodes)
                    ? result.graph.nodes.length
                    : null,
                  edges: Array.isArray(result.graph.edges)
                    ? result.graph.edges.length
                    : null,
                }
              : null,
        }
      : null;
  return {
    evidence_id: item.evidence_id,
    operation: item.operation,
    confidence: item.confidence,
    authority: item.authority,
    limitations: item.limitations,
    summary,
    file: join("evidence", `${item.evidence_id}.json`),
    context_selection:
      "Summary only; inspect_analysis_view or read_file can inspect the complete retained record",
  };
};

/** Owns the complete reason/act/observe loop; host calls never execute its steps. */
export class InvestigationRuns {
  readonly #runs = new Map<string, OwnedRun>();
  readonly #jobs: FeatureInvestigationBinding;
  #closed = false;
  constructor(
    readonly engine: Engine | undefined,
    readonly evidence: EvidenceStore,
    readonly tools: LocalTools,
    private readonly features: FeatureProjectService,
    private readonly skill: string,
    private readonly telemetry = new Telemetry(),
  ) {
    this.#jobs = new FeatureInvestigationBinding(features);
  }
  status() {
    return {
      enabled: this.engine !== undefined,
      models: this.engine?.models ?? null,
      capabilities: this.tools.capabilities(),
      runs: [...this.#runs.values()].map(({ value }) => ({
        run_id: value.run_id,
        question: value.question,
        state: value.state,
        phase: value.phase,
      })),
    };
  }
  start(
    raw: unknown,
  ): Result<
    Pick<InvestigationRun, "run_id" | "state" | "phase">,
    AnalysisError
  > {
    const parsed = taskInputSchema.safeParse(raw);
    if (!parsed.success)
      return err(
        new AnalysisInputError("start_investigation", { cause: parsed.error }),
      );
    const input = parsed.data;
    if (this.#closed || !this.engine)
      return err(
        new AnalysisCapabilityUnavailableError(
          "internal-agent",
          "start_investigation",
          "Configure REA_AI_ENABLED=true, OPENROUTER_API_KEY and REA_AI_ANALYST_MODEL on the server",
        ),
      );
    if (input.review && !this.engine.models.reviewer)
      return err(
        new AnalysisCapabilityUnavailableError(
          "internal-agent",
          "start_investigation",
          "A reviewer was requested without a configured reviewer model",
        ),
      );
    if (
      input.budget.max_requests <
      input.specialists.length + (input.review ? 2 : 1)
    )
      return err(new AnalysisInputError("start_investigation"));
    const prepared = this.#jobs.prepare(legacyInput(input));
    if (!prepared.ok) return prepared;
    const sources: Evidence[] = [];
    try {
      for (const source of input.sources) {
        const raw =
          source.kind === "inline-evidence"
            ? source.evidence
            : this.evidence.get(source.evidence_id);
        if (!raw) throw new Error("Assigned Evidence is unavailable");
        const item = immutableEvidence(raw);
        if (
          !sources.some((existing) => existing.evidence_id === item.evidence_id)
        )
          sources.push(item);
      }
    } catch {
      return err(
        new AnalysisProtocolError(
          "Assigned Evidence is missing or failed integrity validation",
        ),
      );
    }
    const value: InvestigationRun = {
      run_id: randomUUID(),
      question: input.question,
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
    const attached = this.#jobs.attach(value.run_id, legacyInput(input));
    if (!attached.ok) return attached;
    const owned: OwnedRun = {
      value,
      input,
      controller: new AbortController(),
      workspace: null,
      observation: this.telemetry.start("investigation"),
      cancellation: null,
      settled: Promise.resolve(),
    };
    this.#runs.set(value.run_id, owned);
    owned.settled = Promise.resolve()
      .then(() => owned.observation.within(() => this.#run(owned)))
      .finally(() => {
        const state = owned.value.state;
        const outcome = state === "running" ? "error" : state;
        owned.cancellation?.finish(outcome);
        owned.observation.finish(outcome);
      });
    return ok({ run_id: value.run_id, state: value.state, phase: value.phase });
  }
  read(id: string): Result<InvestigationRun, AnalysisError> {
    const run = this.#runs.get(id);
    return run
      ? ok(structuredClone(run.value))
      : err(new AnalysisProtocolError("Unknown investigation run ID"));
  }
  cancel(
    id: string,
  ): Result<
    Pick<InvestigationRun, "run_id" | "state" | "phase">,
    AnalysisError
  > {
    const run = this.#runs.get(id);
    if (!run)
      return err(new AnalysisProtocolError("Unknown investigation run ID"));
    this.#requestCancel(run, "caller");
    return ok({ run_id: id, state: run.value.state, phase: run.value.phase });
  }
  #requestCancel(run: OwnedRun, reason: "caller" | "shutdown" | "deadline") {
    if (run.value.phase === "finished") return;
    run.cancellation ??= run.observation.within(() => this.telemetry.start("cancellation", { reason }));
    run.controller.abort();
  }
  #event(
    value: InvestigationRun,
    role: InvestigationRun["events"][number]["role"],
    message: string,
  ) {
    value.events.push({ sequence: value.events.length, role, message });
  }
  #checkpoint(value: InvestigationRun) {
    const result = this.#jobs.checkpoint(structuredClone(value));
    if (!result.ok) throw result.error;
  }
  async #featureTool(
    name: string,
    raw: unknown,
    owned: OwnedRun,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (!owned.input.feature)
      return err(
        new AnalysisProtocolError(
          "No feature was assigned to this investigation",
        ),
      );
    const inspected = this.features.inspect(owned.input.feature.project_id);
    if (!inspected.ok) return inspected;
    const project = inspected.value.project;
    try {
      let value: unknown;
      if (name === "read_feature_project") {
        z.strictObject({}).parse(raw);
        const { evidence_bundle, ...definition } = project.definition;
        value = {
          project_id: project.project_id,
          revision: project.revision,
          definition,
          evidence_ids: evidence_bundle.records.map((item) => item.evidence_id),
          readiness: inspected.value.readiness,
          verification: inspected.value.verification,
        };
      } else if (name === "revise_feature_project") {
        const input = z
          .strictObject({
            expected_revision: z.number().int().positive(),
            changes: z.record(z.string(), z.unknown()),
          })
          .parse(raw);
        const allowed = new Set([
          "title",
          "goal",
          "candidate",
          "obligations",
          "specification",
          "cases",
          "notes",
          "implementation",
        ]);
        if (Object.keys(input.changes).some((key) => !allowed.has(key)))
          throw new Error(
            "Feature edits cannot replace source bindings or Evidence; use the assigned target and attach observed Evidence",
          );
        const saved = this.features.revise(
          project.project_id,
          input.expected_revision,
          { ...project.definition, ...input.changes },
        );
        if (!saved.ok) return saved;
        value = {
          project_id: saved.value.project_id,
          revision: saved.value.revision,
        };
      } else if (name === "attach_feature_evidence") {
        const input = z
          .strictObject({ expected_revision: z.number().int().positive() })
          .parse(raw);
        const records = [
          ...new Map(
            [
              ...project.definition.evidence_bundle.records,
              ...owned.value.sources,
            ].map((item) => [item.evidence_id, item]),
          ).values(),
        ];
        const saved = this.features.revise(
          project.project_id,
          input.expected_revision,
          {
            ...project.definition,
            evidence_bundle: createEvidenceBundle(
              records,
              project.definition.evidence_bundle.unknowns,
            ),
          },
        );
        if (!saved.ok) return saved;
        value = {
          project_id: saved.value.project_id,
          revision: saved.value.revision,
          records: records.length,
        };
      } else {
        const input = z
          .strictObject({
            left_id: z.string(),
            right_id: z.string(),
            normalization: z.record(z.string(), z.unknown()).optional(),
            origin_pair: z.record(z.string(), z.unknown()).optional(),
          })
          .parse(raw);
        const left = owned.value.sources.find(
            (item) => item.evidence_id === input.left_id,
          ),
          right = owned.value.sources.find(
            (item) => item.evidence_id === input.right_id,
          );
        if (!left || !right)
          throw new Error(
            "Comparison sources must be assigned to this investigation",
          );
        return compareBrowserScenarioEvidence({
          left,
          right,
          ...(input.normalization
            ? { normalization: input.normalization }
            : {}),
          ...(input.origin_pair ? { origin_pair: input.origin_pair } : {}),
        });
      }
      return ok(
        createEvidence(
          undefined,
          {
            id: "rea-feature-workspace",
            name: "REA feature workspace",
            version: "0.1.0",
          },
          {
            operation: name,
            predicateType: "rea.feature-workspace-operation",
            confidence: "derived",
            authority: "analyst-inference",
            parameters: { project_id: project.project_id },
            result: jsonValueSchema.parse(value),
            limitations: [
              "Project declarations and model reports do not establish executed behavior. Canonical verification remains authoritative.",
            ],
          },
        ),
      );
    } catch (cause) {
      return err(
        new AnalysisProtocolError(
          cause instanceof Error ? cause.message : "Feature operation failed",
        ),
      );
    }
  }
  async #run(owned: OwnedRun): Promise<void> {
    const { value, input, controller } = owned;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.#requestCancel(owned, "deadline");
    }, input.budget.timeout_ms);
    try {
      owned.workspace = await this.tools.prepare(
        value.run_id,
        input,
        controller.signal,
      );
      if (owned.workspace.inventory) {
        const record = this.evidence.add(owned.workspace.inventory);
        value.sources.push(record);
      }
      await mkdir(join(owned.workspace.root, "evidence"));
      for (const source of value.sources)
        await writeFile(
          join(owned.workspace.root, "evidence", `${source.evidence_id}.json`),
          JSON.stringify(source, null, 2),
          { flag: "wx" },
        );
      this.#event(
        value,
        "coordinator",
        `Prepared owned workspace ${owned.workspace.root}; internal agents perform the analysis`,
      );
      this.#checkpoint(value);
      const roles = [
        ...input.specialists,
        "analyst" as const,
        ...(input.review ? ["reviewer" as const] : []),
      ];
      const dispatched = new Set<string>();
      for (const role of roles) {
        value.phase = role;
        this.#event(
          value,
          role,
          role === "reviewer"
            ? "Reviewing supplied Evidence and inferred findings"
            : "Executing the scoped investigation with leanrea guidance",
        );
        while (!controller.signal.aborted && value.state === "running") {
          const reserve = roles.filter(
            (item) => item !== role && !dispatched.has(item),
          ).length;
          if (value.generations.length >= input.budget.max_requests - reserve) {
            value.state = "limited";
            value.limitations.push(
              "Caller-selected shared model request budget reached",
            );
            break;
          }
          const context = modelContext(
            {
              question: value.question,
              role,
              platform: process.platform,
              architecture: process.arch,
              analysis_capabilities: this.tools.capabilities(),
              research: { allow_web_search: input.allow_web_search, max_web_searches: input.max_web_searches },
              node_executable: process.execPath,
              workspace: owned.workspace.root,
              target: owned.workspace.target,
              source_target: owned.workspace.originalTarget,
              feature: input.feature ?? null,
              sources:
                role === "reviewer"
                  ? value.sources
                  : value.sources.map((item) => ({
                      evidence_id: item.evidence_id,
                      operation: item.operation,
                      confidence: item.confidence,
                      authority: item.authority,
                      limitations: item.limitations,
                      file: join("evidence", `${item.evidence_id}.json`),
                    })),
              latest_observation: contextObservation(
                value.sources.at(-1),
                input.budget.max_context_bytes,
              ),
              specialists: value.specialists,
              analyst: role === "reviewer" ? value.analyst : null,
            },
            input.budget.max_context_bytes,
            input.sensitive_values,
          );
          if (context === null) {
            value.state = "limited";
            value.limitations.push(
              "Assignment exceeds max_context_bytes; complete local Evidence was retained without truncation",
            );
            break;
          }
          const modelRole = role === "reviewer" ? "reviewer" : "analyst";
          const attempt: InvestigationRun["generations"][number] = {
            role,
            context_sha256: createHash("sha256").update(context).digest("hex"),
            source_evidence_ids: value.sources.map((item) => item.evidence_id),
            requested_model: this.engine!.models[modelRole]!,
            returned_model: null,
            provider: null,
            input_tokens: null,
            output_tokens: null,
            cost_usd: null,
          };
          value.generations.push(attempt);
          dispatched.add(role);
          this.#event(value, role, "Dispatching one bounded model request");
          const featureTools = input.feature
            ? [
                {
                  name: "read_feature_project",
                  description:
                    "Read the assigned feature's current revision, definition, source IDs and deterministic readiness. Source bodies remain scoped to assigned Evidence.",
                  parameters: z.toJSONSchema(z.strictObject({})),
                },
                {
                  name: "revise_feature_project",
                  description:
                    "Update selected definition fields of the assigned feature at its exact expected revision. changes may contain title, goal, candidate, obligations, specification, cases, notes or implementation. Existing Evidence and original binding are preserved. Canonical service validation and proof invalidation apply.",
                  parameters: z.toJSONSchema(
                    z.strictObject({
                      expected_revision: z.number().int().positive(),
                      changes: z.record(z.string(), z.unknown()),
                    }),
                  ),
                },
                {
                  name: "attach_feature_evidence",
                  description:
                    "Attach this investigation's authenticated observations to its assigned feature at the exact expected revision. Does not mark behavior verified.",
                  parameters: z.toJSONSchema(
                    z.strictObject({
                      expected_revision: z.number().int().positive(),
                    }),
                  ),
                },
                {
                  name: "compare_browser_scenario_evidence",
                  description:
                    "Compare two assigned canonical browser scenario captures by exact Evidence IDs. Executes no target. Incompatible or missing authority remains unknown.",
                  parameters: z.toJSONSchema(
                    z.strictObject({
                      left_id: z.string(),
                      right_id: z.string(),
                      normalization: z
                        .record(z.string(), z.unknown())
                        .optional(),
                      origin_pair: z.record(z.string(), z.unknown()).optional(),
                    }),
                  ),
                },
              ]
            : [];
          const availableTools =
            role === "reviewer" || !input.allow_commands
              ? []
              : [
                  ...localToolDefinitions,
                  ...analysisToolDefinitions,
                  ...researchToolDefinitions.filter((tool) => tool.name !== "search_web" || input.allow_web_search),
                  ...featureTools,
                ];
          const generated = await this.telemetry.result("model.request", { role: modelRole }, () => this.engine!.generate({
            role: modelRole,
            context,
            skill: this.skill,
            tools: availableTools,
            maxOutputTokens: input.budget.max_output_tokens,
            maxResponseBytes: input.budget.max_response_bytes,
            signal: controller.signal,
          }), controller.signal);
          if (!generated.ok) {
            if (controller.signal.aborted) break;
            value.state =
              generated.error._tag === "AnalysisResourceConstraintError"
                ? "limited"
                : "failed";
            value.limitations.push(generated.error.message);
            break;
          }
          const generation = generated.value;
          this.telemetry.usage(generation.inputTokens, generation.outputTokens, generation.costUsd, modelRole);
          Object.assign(attempt, {
            returned_model: generation.returnedModel,
            requested_model: generation.requestedModel,
            provider: generation.provider,
            input_tokens: generation.inputTokens,
            output_tokens: generation.outputTokens,
            cost_usd: generation.costUsd,
          });
          if (controller.signal.aborted) break;
          const decision = generation.decision;
          if (decision.kind === "limited" || decision.kind === "failed") {
            value.state = decision.kind;
            value.limitations.push(decision.reason);
            break;
          }
          if (decision.kind === "report") {
            const ids = new Set(value.sources.map((item) => item.evidence_id));
            if (
              decision.report.findings.some((item) =>
                item.evidence_ids.some((id) => !ids.has(id)),
              )
            )
              throw new Error(
                "Model cited Evidence outside this investigation",
              );
            if (role === "analyst" || role === "reviewer")
              value[role] = decision.report;
            else value.specialists.push({ role, report: decision.report });
            this.#event(
              value,
              role,
              `Returned ${decision.report.findings.length} inferred findings`,
            );
            break;
          }
          if (!availableTools.some((tool) => tool.name === decision.name))
            throw new Error(
              "Model requested a tool outside its assigned execution capability",
            );
          const observed = await this.telemetry.result("analysis.call", { role: role === "analyst" || role === "reviewer" ? role : "specialist", tool: decision.name }, async () => featureTools.some(
            (tool) => tool.name === decision.name,
          )
            ? await this.#featureTool(decision.name, decision.arguments, owned)
            : await this.tools.execute(
                decision.name as InternalToolName,
                decision.arguments,
                owned.workspace!,
                value.run_id,
                controller.signal,
                value.sources,
              ), controller.signal);
          const record = this.evidence.add(
            observed.ok
              ? observed.value
              : createEvidence(
                  undefined,
                  {
                    id: "leanrea-local",
                    name: "REA local tool boundary",
                    version: "0.1.0",
                  },
                  {
                    operation: "local_tool_failure",
                    predicateType: "rea.local-tool-failure",
                    parameters: { tool: decision.name },
                    result: {
                      message: observed.error.message,
                      operation_executed: null,
                      diagnostic: jsonValueSchema.parse(
                        projectAnalysisError(observed.error),
                      ),
                    },
                    limitations: [
                      "The requested tool did not produce a successful observation. The internal agent may select an installed fallback; no missing fact is established.",
                    ],
                  },
                ),
          );
          if (
            !value.sources.some(
              (item) => item.evidence_id === record.evidence_id,
            )
          )
            value.sources.push(record);
          await writeFile(
            join(
              owned.workspace.root,
              "evidence",
              `${record.evidence_id}.json`,
            ),
            JSON.stringify(record, null, 2),
            { flag: "wx" },
          ).catch((cause) => {
            if (
              !(cause instanceof Error) ||
              !("code" in cause) ||
              cause.code !== "EEXIST"
            )
              throw cause;
          });
          this.#event(
            value,
            role,
            `Observed ${record.operation}: ${record.evidence_id}`,
          );
          if (
            record.normalized_result &&
            typeof record.normalized_result === "object" &&
            !Array.isArray(record.normalized_result) &&
            record.normalized_result.complete === false
          ) {
            value.state = "limited";
            value.limitations.push(
              "Local command did not complete; its partial Evidence and cleanup status were retained",
            );
          }
        }
        this.#checkpoint(value);
        if (controller.signal.aborted || value.state !== "running") break;
      }
      if (controller.signal.aborted) {
        value.state = timedOut ? "limited" : "cancelled";
        if (timedOut)
          value.limitations.push(
            "Caller-selected investigation deadline reached",
          );
      } else if (value.state === "running") value.state = "completed";
    } catch (cause) {
      value.state = controller.signal.aborted
        ? timedOut
          ? "limited"
          : "cancelled"
        : "failed";
      value.limitations.push(
        cause instanceof Error ? cause.message : "Investigation failed",
      );
    } finally {
      clearTimeout(deadline);
      value.phase = "finished";
      try {
        this.#event(
          value,
          "coordinator",
          `Investigation ${value.state}; findings remain inferred`,
        );
        this.#checkpoint(value);
      } catch {
        value.state = "failed";
        value.limitations.push(
          "Final durable checkpoint failed; live Evidence remains available",
        );
      }
      if (owned.workspace) {
        try {
          await writeFile(
            join(owned.workspace.root, "investigation.json"),
            JSON.stringify(value, null, 2),
            { flag: "wx" },
          );
        } catch {
          value.limitations.push(
            "Local run report could not be written; export the live report before closing",
          );
        }
      }
      const settled = this.#jobs.settled(value.run_id);
      if (!settled.ok) {
        value.state = "failed";
        value.limitations.push(settled.error.message);
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const run of this.#runs.values()) this.#requestCancel(run, "shutdown");
    await Promise.all([...this.#runs.values()].map((run) => run.settled));
    await this.tools.close();
  }
}
