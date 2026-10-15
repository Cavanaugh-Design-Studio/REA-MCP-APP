import { z } from "zod";
import {
  featureDefinitionSchema,
  featureProjectSchema,
} from "../domain/featureProject.js";
import { evidenceSchema } from "../domain/evidence.js";
import { reconstructionVerificationResultSchema } from "../domain/reconstructionVerificationSchemas.js";
import { browserScenarioEvidenceComparisonInputSchema } from "../domain/browserScenarioVerification.js";
import { browserScenarioDiffSchema } from "../domain/browserScenarioDiffValues.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { reconstructionObligationLedgerInputSchema } from "../domain/reconstructionObligationLedgerSchemas.js";

const id = z.string().uuid();
const inspected = z.strictObject({
  project: featureProjectSchema,
  sha256: z.string(),
  ledger: evidenceSchema,
  proofs: z.array(evidenceSchema),
  proof_input: reconstructionObligationLedgerInputSchema,
  verification: reconstructionVerificationResultSchema.nullable(),
  historical_verification: reconstructionVerificationResultSchema.nullable(),
  readiness: z.strictObject({
    state: z.enum(["ready", "fail", "unknown"]),
    reasons: z.array(z.string()),
  }),
  limitations: z.array(z.string()),
});
export const FEATURE_TOOL_CONTRACTS = [
  {
    name: "create_feature_project",
    kind: "session",
    ...toolContractMetadata("create_feature_project"),
    outputSchemaProjection: "normalized-browser-strings",
    description:
      "Create a durable local feature project with exact caller-selected target bindings, authenticated Evidence, canonical reconstruction obligations and optional finite verification. Cloud inference is not required. Persists to REA_PROJECT_STORE or the user's .rea/feature-projects.sqlite. Target bindings are declarations, not observations.",
    inputSchema: featureDefinitionSchema,
    outputSchema: z.strictObject({ result: featureProjectSchema }),
    examples: [],
  },
  {
    name: "read_feature_project",
    kind: "session",
    ...toolContractMetadata("read_feature_project"),
    outputSchemaProjection: "normalized-browser-strings",
    description:
      "Read a durable project or historical revision, authenticate its Evidence and evaluate existing obligation/verification contracts. A passing finite claim does not establish entire application equivalence. No target is launched or changed.",
    inputSchema: z.strictObject({
      project_id: id,
      revision: z.number().int().positive().optional(),
    }),
    outputSchema: z.strictObject({ result: inspected }),
    examples: [],
  },
  {
    name: "list_feature_projects",
    kind: "session",
    ...toolContractMetadata("list_feature_projects"),
    description:
      "List durable local feature projects with current revision and title. Reports connection-independent persisted work; live target sessions are never restored implicitly.",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({
      result: z.strictObject({
        items: z.array(
          featureProjectSchema
            .pick({ project_id: true, revision: true, updated_at: true })
            .extend({ title: z.string(), goal: z.string() }),
        ),
      }),
    }),
    examples: [{ title: "List saved feature work", input: {} }],
  },
  {
    name: "revise_feature_project",
    kind: "session",
    ...toolContractMetadata("revise_feature_project"),
    outputSchemaProjection: "normalized-browser-strings",
    description:
      "Atomically append a complete feature definition at expected_revision. Concurrent/stale writers fail explicitly. Historical Evidence and results remain in prior immutable revisions; new target bindings never silently reuse old proof.",
    inputSchema: z.strictObject({
      project_id: id,
      expected_revision: z.number().int().positive(),
      definition: featureDefinitionSchema,
    }),
    outputSchema: z.strictObject({ result: featureProjectSchema }),
    examples: [],
  },
  {
    name: "export_feature_handoff",
    kind: "session",
    ...toolContractMetadata("export_feature_handoff"),
    description:
      "Export one exact feature revision into an absent absolute output directory: specification, canonical Evidence, obligations, cases, implementation brief and finite verification report. A receipt is published after all artifacts succeed. Partial failed exports are retained explicitly for recovery; no existing files are overwritten.",
    inputSchema: z.strictObject({
      project_id: id,
      revision: z.number().int().positive(),
      output_directory: z.string().min(1),
    }),
    outputSchema: z.strictObject({
      result: z.strictObject({
        path: z.string(),
        files: z.array(
          z.strictObject({
            path: z.string(),
            sha256: z.string(),
            bytes: z.number().int().nonnegative(),
          }),
        ),
      }),
    }),
    examples: [],
  },
  {
    name: "compare_browser_scenario_evidence",
    kind: "session",
    ...toolContractMetadata("compare_browser_scenario_evidence"),
    description:
      "Compare two complete authenticated capture_browser_scenario Evidence records. Retains exact source identities and normalization, returns all step/artifact differences, and creates derived comparison Evidence usable by verify_reconstruction browser-behavior claims. Does not run a scenario; incomplete coverage stays unknown. Source observations must also be retained/imported for verification.",
    inputSchema: browserScenarioEvidenceComparisonInputSchema,
    outputSchema: evidenceResultOf(browserScenarioDiffSchema),
    examples: [],
  },
] as const satisfies readonly ToolContract[];
