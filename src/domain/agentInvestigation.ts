import { z } from "zod";
import { evidenceSchema } from "./evidence.js";
import { prefixedDigestSchema } from "./digests.js";
import { jsonObjectSchema } from "./jsonValue.js";

export const agentEvidenceSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("retained-evidence"),
    evidence_id: prefixedDigestSchema("ev"),
  }),
  z.strictObject({
    kind: z.literal("inline-evidence"),
    evidence: evidenceSchema,
  }),
]);

/** Caller-selected scope and resource budgets; reaching a budget never establishes completeness. */
export const investigationInputSchema = z.strictObject({
  feature: z
    .strictObject({
      project_id: z.string().uuid(),
      expected_revision: z.number().int().positive(),
    })
    .optional(),
  specialists: z
    .array(z.enum(["planner", "static-analyst", "behavior-analyst"]))
    .max(3)
    .default([])
    .refine(
      (values) => new Set(values).size === values.length,
      "Specialist roles must be unique",
    ),
  question: z.string().min(1),
  sources: z.array(agentEvidenceSourceSchema).default([]),
  allow_function_analysis: z.boolean().default(false),
  review: z.boolean().default(true),
  sensitive_values: z.array(z.string().min(1)).default([]),
  budget: z
    .strictObject({
      max_requests: z.number().int().positive().default(8),
      max_output_tokens: z.number().int().positive().default(2048),
      max_context_bytes: z.number().int().positive().default(262144),
      max_response_bytes: z.number().int().positive().default(1048576),
      timeout_ms: z.number().int().positive().max(2147483647).default(120000),
    })
    .default({
      max_requests: 8,
      max_output_tokens: 2048,
      max_context_bytes: 262144,
      max_response_bytes: 1048576,
      timeout_ms: 120000,
    }),
});
export type InvestigationInput = z.infer<typeof investigationInputSchema>;

export const agentFindingSchema = z.strictObject({
  claim: z.string().min(1),
  evidence_ids: z.array(prefixedDigestSchema("ev")).min(1),
  assumptions: z.array(z.string()),
});
export const agentReportSchema = z.strictObject({
  findings: z.array(agentFindingSchema),
  unknowns: z.array(z.string()),
  next_steps: z.array(z.string()),
});
export type AgentReport = z.infer<typeof agentReportSchema>;
export const agentDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("failed"), reason: z.string() }),
  z.strictObject({ kind: z.literal("limited"), reason: z.string() }),
  z.strictObject({
    kind: z.literal("tool"),
    name: z.enum(["inspect_analysis_view", "analyze_function"]),
    arguments: jsonObjectSchema,
  }),
  z.strictObject({ kind: z.literal("report"), ...agentReportSchema.shape }),
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const investigationRunSchema = z.strictObject({
  run_id: z.string().min(1),
  question: z.string(),
  state: z.enum(["running", "completed", "limited", "cancelled", "failed"]),
  phase: z.enum([
    "planner",
    "static-analyst",
    "behavior-analyst",
    "analyst",
    "reviewer",
    "finished",
  ]),
  sources: z.array(evidenceSchema),
  analyst: agentReportSchema.nullable(),
  reviewer: agentReportSchema.nullable(),
  specialists: z
    .array(
      z.strictObject({
        role: z.enum(["planner", "static-analyst", "behavior-analyst"]),
        report: agentReportSchema,
      }),
    )
    .default([]),
  interpretation: z.literal("inferred"),
  events: z.array(
    z.strictObject({
      sequence: z.number().int(),
      role: z.enum([
        "coordinator",
        "planner",
        "static-analyst",
        "behavior-analyst",
        "analyst",
        "reviewer",
      ]),
      message: z.string(),
    }),
  ),
  generations: z.array(
    z.strictObject({
      role: z.enum([
        "planner",
        "static-analyst",
        "behavior-analyst",
        "analyst",
        "reviewer",
      ]),
      context_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      source_evidence_ids: z.array(prefixedDigestSchema("ev")),
      requested_model: z.string(),
      returned_model: z.string().nullable(),
      provider: z.string().nullable(),
      input_tokens: z.number().nonnegative().nullable(),
      output_tokens: z.number().nonnegative().nullable(),
      cost_usd: z.number().nonnegative().nullable(),
    }),
  ),
  limitations: z.array(z.string()),
});
export type InvestigationRun = z.infer<typeof investigationRunSchema>;
export const investigationAcknowledgementSchema = investigationRunSchema.pick({
  run_id: true,
  state: true,
  phase: true,
});
export type InvestigationAcknowledgement = z.infer<
  typeof investigationAcknowledgementSchema
>;
export const investigationReadInputSchema = z.strictObject({
  run_id: z.string().min(1),
  include_sources: z.boolean().default(false),
  source_offset: z.number().int().nonnegative().default(0),
  source_limit: z.number().int().positive().default(1),
});
export const investigationPageSchema = investigationRunSchema.extend({
  total_sources: z.number().int().nonnegative(),
  source_offset: z.number().int().nonnegative(),
  next_source_offset: z.number().int().nonnegative().nullable(),
});
export const runIdInputSchema = z.strictObject({ run_id: z.string().min(1) });
