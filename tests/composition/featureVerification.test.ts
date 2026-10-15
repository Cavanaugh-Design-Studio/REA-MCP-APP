import { expect, it } from "vitest";
import { compareBrowserScenarioEvidence } from "../../src/application/features/BrowserScenarioComparison.js";
import { browserVerificationFixture } from "../../src/domain/browserScenarioVerification.fixture.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { verifyReconstruction } from "../../src/domain/reconstructionVerification.js";
import { browserScenarioSource } from "../../src/domain/browserScenarioVerification.js";
import { createEvidence } from "../../src/domain/evidence.js";

const verify = (
  left = browserVerificationFixture(),
  right = browserVerificationFixture("http://localhost:4200/"),
) => {
  const compared = compareBrowserScenarioEvidence({
    left: left.evidence,
    right: right.evidence,
    origin_pair: {
      before_origin: "http://localhost:4100",
      after_origin: "http://localhost:4200",
    },
    normalization: {
      rules: [
        {
          rule_id: "origin",
          artifacts: ["action_state"],
          match: "http://localhost:4100",
          replacement: "http://localhost:4200",
        },
      ],
    },
  });
  if (!compared.ok) throw compared.error;
  const specification = {
    name: "Feature",
    claims: [
      {
        claim_id: "case",
        kind: "browser-behavior",
        dimension: "overall",
        title: "Finite behavior",
        comparison_evidence_id: compared.value.evidence_id,
      },
    ],
  };
  const bundle = createEvidenceBundle([
    left.evidence,
    right.evidence,
    compared.value,
  ]);
  return {
    result: verifyReconstruction(specification, bundle),
    left,
    right,
    compared: compared.value,
    specification,
    bundle,
  };
};
it("requires explicit origin pairing and preserves actual divergences", () => {
  expect(verify().result.status).toBe("pass");
  expect(
    verify(
      undefined,
      browserVerificationFixture("http://localhost:4200/", "different"),
    ).result.status,
  ).toBe("fail");
  const left = browserVerificationFixture();
  const right = browserVerificationFixture("http://localhost:4200/");
  const unpaired = compareBrowserScenarioEvidence({
    left: left.evidence,
    right: right.evidence,
  });
  if (!unpaired.ok) throw unpaired.error;
  expect(unpaired.value.normalized_result).toMatchObject({
    alignment: {
      status: "partial",
      failures: [{ code: "capture_context_mismatch" }],
    },
  });
});
it("withholds equality for incompatible replay controls and rejects forged comparison status", () => {
  expect(
    verify(
      undefined,
      browserVerificationFixture("http://localhost:4200/", "same", 640),
    ).result.status,
  ).toBe("unknown");
  const value = verify(
    undefined,
    browserVerificationFixture("http://localhost:4200/", "different"),
  );
  const forged = createEvidence(undefined, value.compared.provider, {
    operation: value.compared.operation,
    predicateType: value.compared.predicate_type,
    parameters: value.compared.parameters,
    result: {
      ...(value.compared.normalized_result as object),
      overall_status: "unchanged",
    },
    confidence: "derived",
    authority: "analyst-inference",
    evidenceLinks: value.compared.evidence_links,
  });
  expect(() =>
    verifyReconstruction(
      {
        ...value.specification,
        claims: [
          {
            ...value.specification.claims[0],
            comparison_evidence_id: forged.evidence_id,
          },
        ],
      },
      createEvidenceBundle([value.left.evidence, value.right.evidence, forged]),
    ),
  ).toThrow("disagrees");
});
it("authenticates the scenario commitment as well as the captured result", () => {
  const value = browserVerificationFixture();
  const forged = createEvidence(undefined, value.evidence.provider, {
    operation: value.evidence.operation,
    predicateType: value.evidence.predicate_type,
    parameters: {
      ...value.evidence.parameters,
      scenario_sha256: "0".repeat(64),
    },
    result: value.evidence.normalized_result,
  });
  expect(() => browserScenarioSource(forged)).toThrow("commitment");
});
it("rejects requested artifacts relabeled as unrequested and contradictory completeness", () => {
  const value = browserVerificationFixture();
  const source = (result: unknown) =>
    createEvidence(undefined, value.evidence.provider, {
      operation: value.evidence.operation,
      predicateType: value.evidence.predicate_type,
      parameters: value.evidence.parameters,
      result: result as typeof value.evidence.normalized_result,
    });
  const missing = {
    ...value.capture,
    steps: value.capture.steps.map((step) => ({
      ...step,
      artifacts: { ...step.artifacts, dom: { state: "not_requested" } },
    })),
  };
  expect(() => browserScenarioSource(source(missing))).toThrow(
    "artifact selection",
  );
  const contradictory = {
    ...value.capture,
    steps: value.capture.steps.map((step) => ({
      ...step,
      artifacts: {
        ...step.artifacts,
        dom: { state: "missing", reason: "Unavailable" },
      },
    })),
  };
  expect(() => browserScenarioSource(source(contradictory))).toThrow(
    "completeness",
  );
  const wrongInitial = {
    ...value.capture,
    steps: value.capture.steps.map((step) =>
      step.step_index === 0 ? { ...step, action: "scenario_start" } : step,
    ),
  };
  expect(() => browserScenarioSource(source(wrongInitial))).toThrow(
    "initial step",
  );
});
