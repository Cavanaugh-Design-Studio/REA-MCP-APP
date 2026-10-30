import { z } from "zod";
import {
  createEvidence,
  immutableEvidence,
  type Evidence,
} from "../retained/domain/evidence.js";
import {
  jsonValueSchema,
  jsonObjectSchema,
} from "../retained/domain/jsonValue.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
  managedNativeBoundaryInspectionSchema,
} from "../retained/domain/managed/managedArtifact.js";
import { managedApplicationGraphResultSchema } from "../retained/domain/managed/managedApplicationGraph.js";
import { parseManagedInspectionEvidence } from "../retained/domain/managed/managedInspectionEvidence.js";
import { inspectAnalysisView } from "../retained/application/analysisView/AnalysisViewService.js";
import { AnalysisInputError } from "../retained/domain/analysisErrorCore.js";
import { ok, err, type Result } from "../retained/domain/result.js";
import type { AnalysisError } from "../retained/domain/analysisErrorBase.js";

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("summary") }),
  z.strictObject({
    kind: z.literal("page"),
    collection: z.enum([
      "types",
      "methods",
      "fields",
      "pinvoke_imports",
      "native_implementations",
      "call_edges",
      "field_accesses",
      "references",
      "resources",
      "nodes",
      "edges",
    ]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().positive().max(200).default(50),
  }),
]);
export function inspectStructuredView(
  source: Evidence,
  rawView: unknown,
): Result<Evidence, AnalysisError> {
  if (
    !source.operation.startsWith("inspect_managed_") &&
    source.operation !== "project_managed_application_graph"
  )
    return inspectAnalysisView({
      source: { kind: "inline", evidence: source },
      view: rawView,
    });
  try {
    const authenticated = immutableEvidence(source),
      view = requestSchema.parse(rawView);
    let value: Record<string, unknown>;
    if (authenticated.operation === "project_managed_application_graph") {
      const parsed = managedApplicationGraphResultSchema.parse(
        authenticated.normalized_result,
      );
      if (
        authenticated.subject &&
        authenticated.subject.digest.sha256 !== parsed.root_artifact_sha256
      )
        throw new Error("Managed graph subject digest disagrees");
      value = {
        ...parsed,
        nodes: parsed.graph.nodes,
        edges: parsed.graph.edges,
      };
    } else {
      const schema =
        authenticated.operation === "inspect_managed_artifact"
          ? managedArtifactInspectionSchema
          : authenticated.operation === "inspect_managed_members"
            ? managedMemberInspectionSchema
            : managedNativeBoundaryInspectionSchema;
      value = parseManagedInspectionEvidence(
        authenticated,
        authenticated.operation,
        schema as z.ZodType<{ artifact: { sha256: string } }>,
      ).result;
    }
    const collections = Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => Array.isArray(item))
        .map(([name, item]) => [name, (item as unknown[]).length]),
    );
    let result: unknown;
    if (view.kind === "summary")
      result = {
        kind: "summary",
        parent_evidence_id: authenticated.evidence_id,
        parent_operation: authenticated.operation,
        artifact: value.artifact ?? authenticated.subject,
        module: value.module ?? null,
        assembly: value.assembly ?? null,
        metadata: value.metadata ?? null,
        coverage: value.coverage ?? null,
        collections,
        interpretation:
          authenticated.operation === "project_managed_application_graph"
            ? "inferred"
            : "observed",
      };
    else {
      const items = value[view.collection];
      if (!Array.isArray(items))
        throw new Error(
          "The selected managed collection is unavailable in this source",
        );
      const end = view.offset + view.limit;
      result = {
        kind: "page",
        parent_evidence_id: authenticated.evidence_id,
        collection: view.collection,
        items: items.slice(view.offset, end),
        coverage: {
          status: "page",
          total: items.length,
          examined: Math.max(0, Math.min(end, items.length) - view.offset),
          next_offset: end < items.length ? end : null,
          exhausted: end >= items.length,
        },
      };
    }
    return ok(
      createEvidence(
        undefined,
        {
          id: "rea-analysis-view",
          name: "REA authenticated analysis view",
          version: "1",
        },
        {
          operation: "inspect_analysis_view",
          predicateType: "rea.analysis-view",
          parameters: jsonObjectSchema.parse({
            source_evidence_id: authenticated.evidence_id,
            view,
          }),
          result: jsonValueSchema.parse(result),
          confidence: "derived",
          authority: "analyst-inference",
          evidenceLinks: [authenticated.evidence_id],
          limitations: authenticated.limitations,
        },
      ),
    );
  } catch (cause) {
    return err(new AnalysisInputError("inspect_analysis_view", { cause }));
  }
}
