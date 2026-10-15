import type { Evidence } from "../domain/evidence.js";
import type { ReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";
import type { authenticateFeatureRendererProof } from "./features/FeatureRendererProof.js";

type ProofAuthority = ReconstructionObligation["required_fixture_authority"];
type OriginalAuthority =
  ReconstructionObligation["required_original_authority"];
interface ExpectedProof {
  readonly obligationId: string;
  readonly fixtureId?: string;
  readonly caseKind?: string;
  readonly verifierId?: string;
  readonly claimId?: string;
}

/** Return whether an actual reconstruction proof is comparable to a requirement. */
export const proofAuthoritySatisfies = (
  actual: ProofAuthority,
  required: ProofAuthority,
): boolean => {
  const accepted: Readonly<Record<ProofAuthority, readonly ProofAuthority[]>> =
    {
      unit: [
        "unit",
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
        "external",
      ],
      integration: [
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
      ],
      protocol: ["protocol", "packaged-process", "live-observation"],
      renderer: ["renderer", "packaged-process", "live-observation"],
      "packaged-process": ["packaged-process", "live-observation"],
      "native-abi": ["native-abi"],
      "live-observation": ["live-observation"],
      external: ["external"],
    };
  return accepted[required].includes(actual);
};

/** Check that Evidence can authenticate the declared reconstruction authority. */
export const evidenceAuthoritySupportsProof = (
  evidence: Evidence,
  authority: ProofAuthority,
  expected: ExpectedProof,
  authenticated: ReturnType<typeof authenticateFeatureRendererProof>,
): boolean => {
  if (
    authority !== "renderer" ||
    authenticated === null ||
    evidence.confidence !== "derived"
  )
    return false;
  return authenticated.rows.some(
    (row) =>
      row.status === "pass" &&
      row.obligation_id === expected.obligationId &&
      (expected.fixtureId === undefined ||
        row.fixture_id === expected.fixtureId) &&
      (expected.caseKind === undefined ||
        row.case_kind === expected.caseKind) &&
      (expected.verifierId === undefined ||
        row.verifier_id === expected.verifierId) &&
      (expected.claimId === undefined || row.claim_id === expected.claimId),
  );
};

/** Check that Evidence observes the original at the required boundary. */
export const evidenceSupportsOriginalAuthority = (
  evidence: Evidence,
  authority: OriginalAuthority,
): boolean => {
  if (evidence.confidence !== "observed") return false;
  if (authority === "static") return evidence.authority === "shipped-artifact";
  if (authority === "runtime")
    return ["controlled-replay", "external-service"].includes(
      evidence.authority,
    );
  if (authority === "process")
    return (
      evidence.operation === "capture_process_scenario" &&
      evidence.predicate_type === "rea.process-capture"
    );
  return evidence.authority === "external-service";
};
