import { z } from "zod";
import { evidenceBundleSchema, parseEvidenceBundle } from "./evidenceBundle.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { digestSchema } from "./digests.js";
import { reconstructionSpecificationSchema } from "./reconstructionVerificationSchemas.js";
import {
  reconstructionObligationLedgerInputSchema,
  obligationCaseKindSchema,
} from "./reconstructionObligationLedgerSchemas.js";
import { browserScenarioSchema } from "./browserScenario.js";
import { processScenarioSchema } from "./process/processScenario.js";
import { investigationRunSchema } from "./agentInvestigation.js";
import { parseEvidence } from "./evidence.js";
import { createHash } from "node:crypto";

export const portableFeatureFilePathSchema = z
  .string()
  .regex(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/u)
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (segment) =>
            !segment.endsWith(".") &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
        ),
    "Implementation paths must be portable regular-file names",
  );
const implementationFileSchema = z
  .strictObject({
    path: portableFeatureFilePathSchema,
    sha256: digestSchema,
    content: z.string(),
  })
  .refine(
    (file) =>
      createHash("sha256").update(file.content, "utf8").digest("hex") ===
      file.sha256,
    "Implementation bytes do not match their declared SHA-256",
  );
const implementationSchema = z
  .strictObject({
    files: z.array(implementationFileSchema).min(1),
    launch_instructions: z.array(z.string().min(1)).min(1),
  })
  .superRefine((value, context) => {
    // A trailing separator sorts each directory owner directly before its
    // descendants, even when sibling names contain punctuation (a, a-x, a/x).
    const paths = value.files
      .map((file) => `${file.path.toLowerCase()}/`)
      .sort();
    if (
      paths.some(
        (path, index) => index > 0 && path.startsWith(paths[index - 1]!),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Implementation paths must have unique portable file ownership",
      });
  });

/** Identity is a caller-selected binding, never a claim that REA observed it. */
export const featureTargetSchema = z.strictObject({
  kind: z.enum(["artifact", "browser", "workspace"]),
  location: z.string().min(1),
  sha256: digestSchema.nullable(),
});
const scenarioSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser"), input: browserScenarioSchema }),
  z.strictObject({
    kind: z.literal("process"),
    input: processScenarioSchema.refine(
      (value) =>
        !value.events.some(
          (event) => event.type === "input" && event.sensitive,
        ),
      "Durable feature cases cannot contain explicitly sensitive input bytes. Run secret-bearing scenarios outside the persisted project; retain their redacted Evidence instead.",
    ),
  }),
]);
export const featureCaseSchema = z.strictObject({
  case_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
  title: z.string().min(1),
  obligation_ids: z.array(z.string().min(1)).min(1),
  claim_ids: z.array(z.string().min(1)).default([]),
  case_kind: obligationCaseKindSchema.optional(),
  original: scenarioSchema,
  candidate: scenarioSchema,
});
export const featureDefinitionSchema = z
  .strictObject({
    title: z.string().min(1),
    goal: z.string().min(1),
    original: featureTargetSchema,
    candidate: featureTargetSchema.nullable(),
    evidence_bundle: evidenceBundleSchema,
    obligations: reconstructionObligationLedgerInputSchema.omit({
      evidence_bundle: true,
    }),
    specification: reconstructionSpecificationSchema.nullable(),
    cases: z.array(featureCaseSchema).default([]),
    notes: z.array(z.string()).default([]),
    implementation: implementationSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.cases.map((item) => item.case_id)).size !==
      value.cases.length
    )
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "Case IDs must be unique",
      });
    const obligations = new Set(
      value.obligations.reviewed_obligations.map((item) => item.obligation_id),
    );
    const claims = new Set(
      value.specification?.claims.map((item) => item.claim_id),
    );
    for (const [index, item] of value.cases.entries()) {
      if (item.obligation_ids.some((id) => !obligations.has(id)))
        context.addIssue({
          code: "custom",
          path: ["cases", index, "obligation_ids"],
          message:
            "Case obligation IDs must refer to reviewed feature obligations",
        });
      if (item.claim_ids.some((id) => !claims.has(id)))
        context.addIssue({
          code: "custom",
          path: ["cases", index, "claim_ids"],
          message: "Case claim IDs must refer to the feature specification",
        });
    }
  });
export type FeatureDefinition = z.infer<typeof featureDefinitionSchema>;
/** Exact inputs that own current proof; source bundles are committed separately. */
export const featureProofScopeSchema = z.strictObject({
  original: featureDefinitionSchema.shape.original,
  candidate: featureDefinitionSchema.shape.candidate,
  cases: featureDefinitionSchema.shape.cases,
  obligations: featureDefinitionSchema.shape.obligations,
  specification: featureDefinitionSchema.shape.specification,
  implementation: featureDefinitionSchema.shape.implementation,
});
export const featureJobSchema = z
  .strictObject({
    job_id: z.string().min(1),
    owner_id: z.string().uuid(),
    feature_revision: z.number().int().positive(),
    state: z.enum([
      "running",
      "completed",
      "limited",
      "cancelled",
      "failed",
      "interrupted",
    ]),
    report: investigationRunSchema.nullable(),
    message: z.string(),
  })
  .refine(
    (value) => value.report === null || value.report.run_id === value.job_id,
    "Job report identity must match its owned run",
  );
export const featureProjectSchema = z.strictObject({
  schema_version: z.literal(1),
  project_id: z.string().uuid(),
  revision: z.number().int().positive(),
  previous_sha256: digestSchema.nullable(),
  proof_scope_sha256: digestSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  definition: featureDefinitionSchema,
  jobs: z.array(featureJobSchema),
});
export type FeatureProject = z.infer<typeof featureProjectSchema>;

/** Reauthenticate canonical sources at both write and read boundaries. */
export const parseFeatureProject = (raw: unknown): FeatureProject => {
  const value = featureProjectSchema.parse(raw);
  for (const job of value.jobs) {
    if (!job.report) continue;
    const sources = job.report.sources.map(parseEvidence);
    const ids = new Set(sources.map((source) => source.evidence_id));
    if (
      job.report.generations.some((generation) =>
        generation.source_evidence_ids.some((id) => !ids.has(id)),
      ) ||
      [
        job.report.analyst,
        job.report.reviewer,
        ...job.report.specialists.map((item) => item.report),
      ].some((report) =>
        report?.findings.some((finding) =>
          finding.evidence_ids.some((id) => !ids.has(id)),
        ),
      )
    )
      throw new TypeError(
        "Durable worker report cites an unavailable source observation",
      );
    if (job.state !== "interrupted" && job.state !== job.report.state)
      throw new TypeError("Durable job state disagrees with its worker report");
  }
  return {
    ...value,
    definition: {
      ...value.definition,
      evidence_bundle: parseEvidenceBundle(value.definition.evidence_bundle),
    },
  };
};
export const featureProjectDigest = (value: FeatureProject): string =>
  digestCanonicalValue(value, "Feature project");
export const featureProofScopeDigest = (value: FeatureDefinition): string =>
  digestCanonicalValue(
    {
      original: value.original,
      candidate: value.candidate,
      cases: value.cases,
      reviewed_obligations: value.obligations.reviewed_obligations,
      manifest: value.obligations.manifest,
      specification: value.specification,
      ...(value.implementation ? { implementation: value.implementation } : {}),
    },
    "Feature proof scope",
  );
