import type { FeatureProject, FeatureDefinition } from "./featureProject.js";
import { featureProofScopeDigest } from "./featureProject.js";
import type { Evidence } from "./evidence.js";
import type { ReconstructionVerificationResult } from "./reconstructionVerificationSchemas.js";
import { comparisonSourceEvidenceSides } from "./comparisonSourceEvidence.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { browserScenarioSource } from "./browserScenarioVerification.js";
import { parseProcessCapture } from "./process/processCaptureParsing.js";
import {
  digestProcessCommitment,
  processScenarioCommitment,
} from "./process/processScenario.js";

type Case = FeatureDefinition["cases"][number];
type Target = FeatureDefinition["original"];
type Role = "original" | "candidate";
type Claim = ReconstructionVerificationResult["claims"]["items"][number];

const browserBindingReasons = (
  target: Target,
  source: Evidence,
  scenario: Extract<Case["original"], { kind: "browser" }>,
  role: Role,
): string[] => {
  browserScenarioSource(source);
  const reasons: string[] = [];
  const start = source.parameters.start_url;
  if (
    target.kind !== "browser" ||
    typeof start !== "object" ||
    start === null ||
    Array.isArray(start) ||
    start.url !== target.location ||
    !Array.isArray(start.query) ||
    start.query.length !== 0
  )
    reasons.push(
      `The ${role} observation does not establish the exact selected browser URL.`,
    );
  if (target.sha256 !== null)
    reasons.push(
      `The ${role} browser capture does not establish the declared artifact digest.`,
    );
  if (
    source.parameters.scenario_sha256 !== digestCanonicalValue(scenario.input)
  )
    reasons.push(`The ${role} proof was captured using a different scenario.`);
  return reasons;
};

const processBindingReasons = (
  target: Target,
  source: Evidence,
  scenario: Extract<Case["original"], { kind: "process" }>,
  role: Role,
): string[] => {
  if (
    source.operation !== "capture_process_scenario" ||
    source.predicate_type !== "rea.process-capture"
  )
    throw new TypeError(
      "A canonical process capture is required for a process case",
    );
  const capture = parseProcessCapture(source.normalized_result);
  const reasons: string[] = [];
  if (
    target.kind !== "artifact" ||
    target.sha256 === null ||
    capture.manifest.executable_identity.state !== "path_metadata_unchanged" ||
    capture.manifest.executable_sha256 !== target.sha256 ||
    capture.manifest.scenario.executable !== target.location
  )
    reasons.push(
      `The ${role} observation does not establish the selected executable path and launch digest.`,
    );
  const expected = processScenarioCommitment(
    scenario.input,
    capture.manifest.selected_executable_sha256 ?? undefined,
  );
  if (
    capture.manifest.full_scenario_sha256 !== digestProcessCommitment(expected)
  )
    reasons.push(
      `The ${role} proof was captured using a different process scenario.`,
    );
  return reasons;
};

const caseBindingReasons = (
  definition: FeatureDefinition,
  claim: Claim,
  records: ReadonlyMap<string, Evidence>,
): string[] => {
  const reasons: string[] = [];
  const cases = definition.cases.filter((item) =>
    item.claim_ids.includes(claim.claim_id),
  );
  if (cases.length !== 1)
    reasons.push(
      "Each current feature claim needs exactly one declared original/candidate case.",
    );
  const selected = cases[0];
  if (!selected) return reasons;
  const reviewedIds = new Set(
    definition.obligations.reviewed_obligations.map(
      (item) => item.obligation_id,
    ),
  );
  if (selected.obligation_ids.some((id) => !reviewedIds.has(id)))
    reasons.push(
      "Case refers to an obligation outside the reviewed feature scope.",
    );
  const comparison = records.get(claim.comparison_evidence_id);
  if (!comparison)
    return [...reasons, "The feature comparison is unavailable."];
  const sides = comparisonSourceEvidenceSides(comparison);
  if (sides.left.length !== 1 || sides.right.length !== 1)
    reasons.push(
      "Feature cases require exactly one observation on each comparison side.",
    );
  for (const [role, ids] of [
    ["original", sides.left],
    ["candidate", sides.right],
  ] as const) {
    const source = records.get(ids[0] ?? "");
    const target = definition[role];
    if (!source || !target) {
      reasons.push(`The ${role} observation identity is unavailable.`);
      continue;
    }
    const scenario = selected[role];
    reasons.push(
      ...(scenario.kind === "browser"
        ? browserBindingReasons(target, source, scenario, role)
        : processBindingReasons(target, source, scenario, role)),
    );
  }
  return reasons;
};

/** Current feature proof binds finite claims to observation identities and selected cases. */
export const bindFeatureVerification = (
  project: Pick<FeatureProject, "definition" | "proof_scope_sha256">,
  historical: ReconstructionVerificationResult | null,
) => {
  const definition = project.definition;
  const globalReasons: string[] = [];
  if (project.proof_scope_sha256 !== featureProofScopeDigest(definition))
    globalReasons.push(
      "Proof belongs to an earlier target, case or obligation scope. Capture new proof for the current feature.",
    );
  if (!definition.candidate)
    globalReasons.push("No candidate target is selected.");
  if (definition.cases.length === 0)
    globalReasons.push("No original/candidate execution cases are declared.");
  if (!historical)
    return {
      verification: null,
      reasons: [
        ...globalReasons,
        "No finite comparison specification is supplied.",
      ],
    };
  const records = new Map(
    definition.evidence_bundle.records.map((record) => [
      record.evidence_id,
      record,
    ]),
  );
  const items = historical.claims.items.map((claim) => {
    const reasons = [
      ...globalReasons,
      ...caseBindingReasons(definition, claim, records),
    ];
    return reasons.length
      ? {
          ...claim,
          status: "unknown" as const,
          limitations: [...claim.limitations, ...reasons],
        }
      : claim;
  });
  for (const obligation of definition.obligations.reviewed_obligations.filter(
    (item) => item.required && item.disposition === "active",
  ))
    if (
      !definition.cases.some(
        (item) =>
          item.obligation_ids.includes(obligation.obligation_id) &&
          item.claim_ids.length > 0,
      )
    )
      globalReasons.push(
        `Required obligation ${obligation.obligation_id} has no bound verification case.`,
      );
  const passed = items.filter((item) => item.status === "pass").length;
  const failed = items.filter((item) => item.status === "fail").length;
  const unknown = items.length - passed - failed;
  return {
    verification: {
      ...historical,
      status: failed
        ? ("fail" as const)
        : unknown
          ? ("unknown" as const)
          : ("pass" as const),
      summary: { ...historical.summary, passed, failed, unknown },
      claims: { items },
    },
    reasons: [...new Set(globalReasons)],
  };
};
