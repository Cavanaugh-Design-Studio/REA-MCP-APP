import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SqliteFeatureProjectStore } from "../../projects/SqliteFeatureProjectStore.js";
import { FeatureProjectService } from "./FeatureProjectService.js";
import { browserVerificationFixture } from "../../domain/browserScenarioVerification.fixture.js";
import {
  featureDefinitionSchema,
  type FeatureDefinition,
} from "../../domain/featureProject.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { reviewedObligation } from "../ReconstructionObligationLedger.fixture.js";
import { compareBrowserScenarioEvidence } from "./BrowserScenarioComparison.js";
import { buildReconstructionObligationLedgerEvidenceValidated } from "../ReconstructionObligationLedgerService.js";
import {
  authenticateFeatureRendererProof,
  deriveFeatureRendererProof,
  FEATURE_RENDERER_VERIFIER,
} from "./FeatureRendererProof.js";
import {
  createResidualUnknown,
  recordUnknownInputSchema,
} from "../../domain/residualUnknown.js";

const definition = (): FeatureDefinition => {
  const left = browserVerificationFixture("http://localhost:4100/");
  const right = browserVerificationFixture("http://localhost:4101/");
  const compared = compareBrowserScenarioEvidence({
    left: left.evidence,
    right: right.evidence,
    origin_pair: {
      before_origin: "http://localhost:4100",
      after_origin: "http://localhost:4101",
    },
    normalization: {
      rules: [
        {
          rule_id: "origin",
          artifacts: ["action_state"],
          match: "http://localhost:4100",
          replacement: "http://localhost:4101",
        },
      ],
    },
  });
  if (!compared.ok) throw compared.error;
  const reviewed = {
    ...reviewedObligation("feature.annotation", left.evidence.evidence_id),
    target: {
      artifact_sha256: null,
      application_node_id: null,
      semantic_node_id: null,
      location: "http://localhost:4100/",
    },
    required_original_authority: "runtime",
    required_fixture_authority: "renderer",
    required_verifier_authority: "renderer",
    required_next_evidence: [],
  };
  return featureDefinitionSchema.parse({
    title: "Annotation",
    goal: "Finite browser proof",
    original: {
      kind: "browser",
      location: "http://localhost:4100/",
      sha256: null,
    },
    candidate: {
      kind: "browser",
      location: "http://localhost:4101/",
      sha256: null,
    },
    evidence_bundle: createEvidenceBundle([
      left.evidence,
      right.evidence,
      compared.value,
    ]),
    obligations: {
      reviewed_obligations: [reviewed],
      manifest: {
        contradictions: [],
        bindings: [
          {
            obligation_id: reviewed.obligation_id,
            owner: {
              module_path: "candidate.js",
              symbol: "annotation",
              owner_sha256: "a".repeat(64),
            },
            parser_type: null,
            original_cases: [
              {
                kind: "positive",
                evidence_id: left.evidence.evidence_id,
                location: "scenario/positive",
              },
            ],
            fixtures: [
              {
                fixture_id: "fixture.annotation",
                case_kind: "positive",
                authority: "renderer",
                evidence_ids: [right.evidence.evidence_id],
              },
            ],
            verifier: {
              verifier_id: "verifier.annotation",
              claim_id: "claim.annotation",
              command: FEATURE_RENDERER_VERIFIER,
              authority: "renderer",
              status: "unknown",
              result_evidence_id: compared.value.evidence_id,
              enumerated_obligation_ids: [reviewed.obligation_id],
              nondeterminism: {
                mode: "total-order",
                specification: "Finite ordered steps",
              },
            },
          },
        ],
      },
    },
    specification: {
      name: "Annotation",
      claims: [
        {
          claim_id: "claim.annotation",
          title: "Behavior",
          kind: "browser-behavior",
          dimension: "overall",
          comparison_evidence_id: compared.value.evidence_id,
        },
      ],
    },
    cases: [
      {
        case_id: "annotation",
        title: "Annotation",
        case_kind: "positive",
        obligation_ids: [reviewed.obligation_id],
        claim_ids: ["claim.annotation"],
        original: { kind: "browser", input: left.scenario },
        candidate: { kind: "browser", input: right.scenario },
      },
    ],
  });
};
const ledger = (
  input: FeatureDefinition,
  derived = deriveFeatureRendererProof(input),
) => {
  const built = buildReconstructionObligationLedgerEvidenceValidated({
    ...input.obligations,
    manifest: derived.manifest,
    evidence_bundle: derived.bundle,
  });
  if (!built.ok) throw built.error;
  return built.value.normalized_result;
};
it("cannot refresh changed implementation proof by relabeling comparisons or removing and restoring old sources", async () => {
  const service = new FeatureProjectService(
    new SqliteFeatureProjectStore(
      join(
        await createTestTempDirectory("rea-proof-history-"),
        "projects.sqlite",
      ),
    ),
  );
  try {
    const initial = definition();
    const created = service.create(initial);
    if (!created.ok) throw created.error;
    expect(service.inspect(created.value.project_id)).toMatchObject({
      ok: true,
      value: { readiness: { state: "ready" } },
    });
    const binding = initial.obligations.manifest.bindings[0]!;
    const left = initial.evidence_bundle.records.find(
      (record) => record.evidence_id === binding.original_cases[0]!.evidence_id,
    );
    const right = initial.evidence_bundle.records.find(
      (record) => record.evidence_id === binding.fixtures[0]!.evidence_ids[0],
    );
    const compared = compareBrowserScenarioEvidence({
      left: left!,
      right: right!,
      origin_pair: {
        before_origin: "http://localhost:4100",
        after_origin: "http://localhost:4101",
      },
      normalization: {
        rules: [
          {
            rule_id: "origin-relabelled",
            artifacts: ["action_state"],
            match: "http://localhost:4100",
            replacement: "http://localhost:4101",
          },
        ],
      },
    });
    if (!compared.ok) throw compared.error;
    const changed: FeatureDefinition = {
      ...initial,
      implementation: {
        files: [
          {
            path: "candidate.js",
            content: "",
            sha256: createHash("sha256").update("").digest("hex"),
          },
        ],
        launch_instructions: ["Caller-declared implementation"],
      },
      evidence_bundle: createEvidenceBundle([
        ...initial.evidence_bundle.records,
        compared.value,
      ]),
      specification: {
        ...initial.specification!,
        claims: initial.specification!.claims.map((claim) => ({
          ...claim,
          comparison_evidence_id: compared.value.evidence_id,
        })),
      },
      obligations: {
        ...initial.obligations,
        manifest: {
          ...initial.obligations.manifest,
          bindings: initial.obligations.manifest.bindings.map((binding) => ({
            ...binding,
            verifier: {
              ...binding.verifier!,
              result_evidence_id: compared.value.evidence_id,
            },
          })),
        },
      },
    };
    const revised = service.revise(created.value.project_id, 1, changed);
    if (!revised.ok) throw revised.error;
    expect(service.inspect(created.value.project_id)).toMatchObject({
      ok: true,
      value: { readiness: { state: "unknown" } },
    });
    const cleared = service.revise(created.value.project_id, 2, {
      ...changed,
      specification: null,
      cases: [],
      evidence_bundle: createEvidenceBundle([]),
      obligations: {
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      },
    });
    if (!cleared.ok) throw cleared.error;
    const restored = service.revise(created.value.project_id, 3, changed);
    if (!restored.ok) throw restored.error;
    expect(service.inspect(created.value.project_id)).toMatchObject({
      ok: true,
      value: { readiness: { state: "unknown" } },
    });
  } finally {
    service.store.close();
  }
});
it.each(["unknown", "unsupported", "skipped", "fail"] as const)(
  "distinguishes verifier %s from missing proof",
  (status) => {
    const input = definition();
    input.obligations.manifest.bindings[0]!.verifier!.status = status;
    const result = ledger(input, {
      proof: null,
      bundle: input.evidence_bundle,
      manifest: input.obligations.manifest,
    });
    expect(result).toMatchObject({
      status: status === "fail" ? "failed" : "open",
    });
  },
);
describe("source-backed canonical renderer proof (simulated captures only)", () => {
  it("retains historical proof referenced by an unknown and rejects reuse after the unknown closure changes", () => {
    const input = definition(),
      historical = deriveFeatureRendererProof(input);
    const unknown = createResidualUnknown(
      recordUnknownInputSchema.parse({
        question: "Has packaging been verified?",
        severity: "high",
        domain: "packaging",
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        supporting_evidence_ids: [historical.proof!.evidence_id],
      }),
      input.evidence_bundle.records[0]!.evidence_id,
      null,
    );
    input.evidence_bundle = createEvidenceBundle(historical.bundle.records, [
      unknown,
    ]);
    const derived = deriveFeatureRendererProof(input);
    expect(derived.bundle.unknowns).toEqual([unknown]);
    expect(derived.proof?.evidence_links).toContain(
      historical.proof!.evidence_id,
    );
    expect(
      derived.proof &&
        authenticateFeatureRendererProof(derived.proof, derived.bundle),
    ).not.toBeNull();
    expect(
      authenticateFeatureRendererProof(
        historical.proof!,
        input.evidence_bundle,
      ),
    ).toBeNull();
  });
  it("recomputes exact tuples and closes the canonical finite renderer ledger", () => {
    const input = definition(),
      derived = deriveFeatureRendererProof(input);
    expect(derived.proof).toMatchObject({
      confidence: "derived",
      authority: "analyst-inference",
    });
    expect(derived.proof?.evidence_links).toEqual(
      input.evidence_bundle.records.map((item) => item.evidence_id).sort(),
    );
    expect(
      derived.proof &&
        authenticateFeatureRendererProof(derived.proof, derived.bundle),
    ).not.toBeNull();
    expect(ledger(input, derived)).toMatchObject({
      status: "ready",
      summary: { required_open: 0 },
    });
  });
  it.each([
    "target",
    "artifact",
    "missing-kind",
    "wrong-original-kind",
    "ambiguous-fixture",
    "command",
    "claim",
    "enumeration",
  ])("does not produce proof for a substituted %s declaration", (kind) => {
    const input = definition(),
      binding = input.obligations.manifest.bindings[0]!;
    if (kind === "target")
      input.obligations.reviewed_obligations[0]!.target.location =
        "http://localhost:other/";
    if (kind === "artifact")
      input.obligations.reviewed_obligations[0]!.target.artifact_sha256 =
        "b".repeat(64);
    if (kind === "missing-kind") delete input.cases[0]!.case_kind;
    if (kind === "wrong-original-kind")
      binding.original_cases[0]!.kind = "negative";
    if (kind === "ambiguous-fixture")
      binding.fixtures.push({
        ...binding.fixtures[0]!,
        fixture_id: "fixture.ambiguous",
      });
    if (kind === "command") binding.verifier!.command = "arbitrary-command";
    if (kind === "claim") binding.verifier!.claim_id = "claim.unrelated";
    if (kind === "enumeration")
      binding.verifier!.enumerated_obligation_ids.push("other.obligation");
    expect(deriveFeatureRendererProof(input).proof).toBeNull();
    expect(ledger(input)).not.toMatchObject({ status: "ready" });
  });
  it.each([
    "version",
    "owner",
    "parser",
    "stronger-authority",
    "source-removed",
  ])("rejects proof reused under a changed %s", (kind) => {
    const input = definition(),
      derived = deriveFeatureRendererProof(input);
    if (kind === "version")
      input.obligations.reviewed_obligations[0]!.obligation_version += 1;
    if (kind === "owner")
      derived.manifest.bindings[0]!.owner.owner_sha256 = "b".repeat(64);
    if (kind === "parser")
      derived.manifest.bindings[0]!.parser_type = {
        parser: "changed",
        schema: "changed",
        domain_type: "changed",
      };
    if (kind === "stronger-authority")
      input.obligations.reviewed_obligations[0]!.required_verifier_authority =
        "packaged-process";
    if (kind === "source-removed")
      derived.bundle = createEvidenceBundle(
        derived.bundle.records.filter(
          (item) =>
            item.evidence_id !== input.evidence_bundle.records[0]!.evidence_id,
        ),
      );
    expect(ledger(input, derived)).not.toMatchObject({ status: "ready" });
  });
});
