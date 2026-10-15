import { z } from "zod";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../../domain/evidenceBundle.js";
import {
  featureDefinitionSchema,
  featureProofScopeSchema,
  featureProofScopeDigest,
  type FeatureDefinition,
} from "../../domain/featureProject.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { jsonObjectSchema, jsonValueSchema } from "../../domain/jsonValue.js";
import { verifyReconstruction } from "../../domain/reconstructionVerification.js";
import { bindFeatureVerification } from "../../domain/featureVerificationBinding.js";
import { browserScenarioSource } from "../../domain/browserScenarioVerification.js";
import {
  obligationCaseKindSchema,
  type ReconstructionObligationManifest,
} from "../../domain/reconstructionObligationLedgerSchemas.js";
import type { ReconstructionObligationCandidate } from "../ReconstructionObligationCandidates.js";

export const FEATURE_RENDERER_VERIFIER = "rea:browser-scenario-equality";
const OPERATION = "derive_feature_renderer_proof";
const PREDICATE = "rea.feature-renderer-proof";
const rowSchema = z.strictObject({
  obligation_id: z.string(),
  obligation_version: z.number().int().positive(),
  feature_case_id: z.string(),
  fixture_id: z.string(),
  case_kind: obligationCaseKindSchema,
  verifier_id: z.string(),
  claim_id: z.string(),
  comparison_evidence_id: z.string(),
  original_capture_id: z.string(),
  candidate_capture_id: z.string(),
  status: z.enum(["pass", "fail"]),
});
export const featureRendererProofSchema = z.strictObject({
  schema_version: z.literal(1),
  authority: z.literal("renderer"),
  scope: featureProofScopeSchema,
  source_bundle_sha256: z.string(),
  rows: z.array(rowSchema).min(1),
});
type Row = z.infer<typeof rowSchema>;
type Binding = ReconstructionObligationManifest["bindings"][number];
type Claim = NonNullable<
  ReturnType<typeof bindFeatureVerification>["verification"]
>["claims"]["items"][number];

/** Source closure and exact declarations, never ledger status, determine proof. */
export const deriveFeatureRendererProof = (
  definitionInput: FeatureDefinition,
) => {
  const definition = featureDefinitionSchema.parse(definitionInput);
  const authenticated = parseEvidenceBundle(definition.evidence_bundle);
  // Historical proof is ordinary source data when callers retain or reference it.
  // The new output is not present in this immutable input closure.
  const sourceBundle = authenticated;
  const records = new Map(
    sourceBundle.records.map((item) => [item.evidence_id, item]),
  );
  const historical = definition.specification
    ? verifyReconstruction(definition.specification, sourceBundle)
    : null;
  const bound = bindFeatureVerification(
    { definition, proof_scope_sha256: featureProofScopeDigest(definition) },
    historical,
  );
  const rows: Row[] = [];
  for (const claim of bound.verification?.claims.items ?? []) {
    if (claim.kind !== "browser-behavior" || claim.status === "unknown")
      continue;
    const selected = definition.cases.filter((item) =>
      item.claim_ids.includes(claim.claim_id),
    );
    const item = selected[0];
    if (
      selected.length !== 1 ||
      !item?.case_kind ||
      item.original.kind !== "browser" ||
      item.candidate.kind !== "browser"
    )
      continue;
    const left = records.get(claim.left_evidence_ids[0] ?? "");
    const right = records.get(claim.right_evidence_ids[0] ?? "");
    if (
      !left ||
      !right ||
      left.evidence_id === right.evidence_id ||
      claim.left_evidence_ids.length !== 1 ||
      claim.right_evidence_ids.length !== 1
    )
      continue;
    if (
      ![left, right].every(
        (source) =>
          source.confidence === "observed" &&
          source.authority === "controlled-replay",
      )
    )
      continue;
    browserScenarioSource(left);
    browserScenarioSource(right);
    for (const id of item.obligation_ids) {
      const obligations = definition.obligations.reviewed_obligations.filter(
        (obligation) => obligation.obligation_id === id,
      );
      const bindings = definition.obligations.manifest.bindings.filter(
        (binding) => binding.obligation_id === id,
      );
      const obligation = obligations[0];
      const binding = bindings[0];
      if (
        obligations.length !== 1 ||
        !obligation ||
        bindings.length !== 1 ||
        !binding
      )
        continue;
      if (
        obligation.target.location !== definition.original.location ||
        obligation.target.artifact_sha256 !== null ||
        obligation.target.application_node_id !== null ||
        obligation.target.semantic_node_id !== null
      )
        continue;
      const row = joinProofRow(item, claim, obligation, binding, left, right);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) =>
    digestCanonicalValue(a).localeCompare(digestCanonicalValue(b)),
  );
  // A verifier's declared enumeration must be exactly supported, not a superset.
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const declaration = definition.obligations.manifest.bindings.find(
      (binding) => binding.obligation_id === row.obligation_id,
    )?.verifier;
    const supported = [
      ...new Set(
        rows
          .filter(
            (item) =>
              item.verifier_id === row.verifier_id &&
              item.claim_id === row.claim_id,
          )
          .map((item) => item.obligation_id),
      ),
    ].sort();
    if (
      !declaration ||
      digestCanonicalValue(
        [...new Set(declaration.enumerated_obligation_ids)].sort(),
      ) !== digestCanonicalValue(supported)
    )
      rows.splice(index, 1);
  }
  if (!rows.length)
    return {
      proof: null,
      bundle: sourceBundle,
      manifest: definition.obligations.manifest,
    };
  const {
    original,
    candidate,
    cases,
    obligations,
    specification,
    implementation,
  } = definition;
  const result = featureRendererProofSchema.parse({
    schema_version: 1,
    authority: "renderer",
    scope: {
      original,
      candidate,
      cases,
      obligations,
      specification,
      ...(implementation ? { implementation } : {}),
    },
    source_bundle_sha256: digestCanonicalValue(sourceBundle),
    rows,
  });
  const proof = createEvidence(
    undefined,
    {
      id: "rea-feature-renderer-proof",
      name: "REA source-backed renderer verifier",
      version: "1",
    },
    {
      operation: OPERATION,
      predicateType: PREDICATE,
      parameters: jsonObjectSchema.parse({
        feature_scope_sha256: featureProofScopeDigest(definition),
        source_bundle_sha256: result.source_bundle_sha256,
      }),
      result: jsonValueSchema.parse(result),
      confidence: "derived",
      authority: "analyst-inference",
      environment: null,
      evidenceLinks: sourceBundle.records
        .map((item) => item.evidence_id)
        .sort(),
      limitations: [
        "Derived finite renderer proof recomputed from supplied canonical observations. Caller declarations and semantic digests are not execution signatures. Owner paths/digests remain declarations; no arbitrary verifier command, packaged build or native ABI is certified.",
      ],
    },
  );
  const manifest = effectiveManifest(
    definition.obligations.manifest,
    proof,
    rows,
  );
  return {
    proof,
    bundle: createEvidenceBundle(
      [...sourceBundle.records, proof],
      sourceBundle.unknowns,
    ),
    manifest,
  };
};

const joinProofRow = (
  item: FeatureDefinition["cases"][number],
  claim: Claim,
  obligation: FeatureDefinition["obligations"]["reviewed_obligations"][number],
  binding: Binding,
  left: Evidence,
  right: Evidence,
): Row | null => {
  const verifier = binding.verifier;
  if (
    !item.case_kind ||
    !verifier ||
    verifier.command !== FEATURE_RENDERER_VERIFIER ||
    verifier.authority !== "renderer" ||
    verifier.claim_id !== claim.claim_id ||
    !verifier.enumerated_obligation_ids.includes(obligation.obligation_id)
  )
    return null;
  if (
    verifier.enumerated_obligation_ids.some(
      (id) => !item.obligation_ids.includes(id),
    )
  )
    return null;
  if (
    !obligation.required_case_kinds.includes(item.case_kind) ||
    !binding.original_cases.some(
      (original) =>
        original.kind === item.case_kind &&
        original.evidence_id === left.evidence_id,
    )
  )
    return null;
  const fixtures = binding.fixtures.filter(
    (fixture) =>
      fixture.case_kind === item.case_kind &&
      fixture.authority === "renderer" &&
      fixture.evidence_ids.length === 1 &&
      [right.evidence_id, claim.comparison_evidence_id].includes(
        fixture.evidence_ids[0]!,
      ),
  );
  if (fixtures.length !== 1) return null;
  return {
    obligation_id: obligation.obligation_id,
    obligation_version: obligation.obligation_version,
    feature_case_id: item.case_id,
    fixture_id: fixtures[0]!.fixture_id,
    case_kind: item.case_kind,
    verifier_id: verifier.verifier_id,
    claim_id: claim.claim_id,
    comparison_evidence_id: claim.comparison_evidence_id,
    original_capture_id: left.evidence_id,
    candidate_capture_id: right.evidence_id,
    status: claim.status as "pass" | "fail",
  };
};

const effectiveManifest = (
  input: ReconstructionObligationManifest,
  proof: Evidence,
  rows: readonly Row[],
): ReconstructionObligationManifest => ({
  ...input,
  bindings: input.bindings.map((binding) => {
    const selected = rows.filter(
      (row) => row.obligation_id === binding.obligation_id,
    );
    if (!selected.length || !binding.verifier) return binding;
    return {
      ...binding,
      fixtures: binding.fixtures.map((fixture) =>
        selected.some(
          (row) =>
            row.fixture_id === fixture.fixture_id &&
            row.case_kind === fixture.case_kind,
        )
          ? { ...fixture, evidence_ids: [proof.evidence_id] }
          : fixture,
      ),
      verifier: {
        ...binding.verifier,
        result_evidence_id: proof.evidence_id,
        status: selected.every((row) => row.status === "pass")
          ? "pass"
          : "fail",
      },
    };
  }),
});

/** Public canonical-ledger evaluation independently recomputes the complete proof. */
export const authenticateFeatureRendererProof = (
  raw: Evidence,
  bundle: EvidenceBundle,
) => {
  try {
    const proof = parseEvidence(raw);
    if (
      proof.operation !== OPERATION ||
      proof.predicate_type !== PREDICATE ||
      proof.confidence !== "derived" ||
      proof.authority !== "analyst-inference"
    )
      return null;
    const parsed = featureRendererProofSchema.parse(proof.normalized_result);
    const authenticated = parseEvidenceBundle(bundle);
    const ids = new Set(proof.evidence_links);
    if (ids.has(proof.evidence_id)) return null;
    const sourceBundle = createEvidenceBundle(
      authenticated.records.filter((item) => ids.has(item.evidence_id)),
      authenticated.unknowns,
    );
    if (
      sourceBundle.records.length !== ids.size ||
      digestCanonicalValue(sourceBundle) !== parsed.source_bundle_sha256
    )
      return null;
    const derived = deriveFeatureRendererProof({
      ...parsed.scope,
      title: "Renderer proof",
      goal: "Recompute source closure",
      notes: [],
      evidence_bundle: sourceBundle,
    });
    if (!derived.proof || derived.proof.evidence_id !== proof.evidence_id)
      return null;
    return {
      rows: parsed.rows,
      reviewed: parsed.scope.obligations.reviewed_obligations,
      manifest: derived.manifest,
    };
  } catch {
    return null;
  }
};

/** Exact requirement and binding identity prevent reuse under a changed owner/version. */
export const rendererProofRequirementMatches = (
  proof: NonNullable<ReturnType<typeof authenticateFeatureRendererProof>>,
  candidate: ReconstructionObligationCandidate,
  binding: Binding,
): boolean => {
  const reviewed = proof.reviewed.find(
    (item) => item.obligation_id === candidate.obligation_id,
  );
  const effective = proof.manifest.bindings.filter(
    (item) => item.obligation_id === candidate.obligation_id,
  );
  if (
    !reviewed ||
    candidate.origin !== "reviewed" ||
    candidate.definitionCount !== 1 ||
    candidate.disposition !== reviewed.disposition ||
    effective.length !== 1 ||
    digestCanonicalValue(effective[0]) !== digestCanonicalValue(binding)
  )
    return false;
  if (
    digestCanonicalValue(reviewed.review_evidence_ids) !==
    digestCanonicalValue(
      candidate.authority_references.map((item) => item.evidence_id),
    )
  )
    return false;
  return Object.entries(reviewed).every(
    ([key, value]) =>
      key === "review_evidence_ids" ||
      key === "disposition" ||
      digestCanonicalValue(value) ===
        digestCanonicalValue(Reflect.get(candidate, key)),
  );
};
