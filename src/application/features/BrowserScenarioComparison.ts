import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { compareBrowserScenariosInputSchema } from "../../domain/browserScenarioDiffValues.js";
import { compareBrowserScenarios } from "../../domain/browserScenarioDiff.js";
import {
  BROWSER_SCENARIO_COMPARISON_PROVIDER,
  browserScenarioSource,
  browserScenarioEvidenceComparisonInputSchema,
} from "../../domain/browserScenarioVerification.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ok, err, type Result } from "../../domain/result.js";
export const compareBrowserScenarioEvidence = (
  raw: unknown,
): Result<Evidence, AnalysisError> => {
  try {
    const input = browserScenarioEvidenceComparisonInputSchema.parse(raw);
    const left = browserScenarioSource(input.left);
    const right = browserScenarioSource(input.right);
    const result = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: left.normalized_result,
        after_scenario: right.normalized_result,
        normalization: input.normalization,
        ...(input.origin_pair === undefined
          ? {}
          : { origin_pair: input.origin_pair }),
      }),
    );
    return ok(
      createEvidence(undefined, BROWSER_SCENARIO_COMPARISON_PROVIDER, {
        operation: "compare_browser_scenario_evidence",
        predicateType: "rea.browser-scenario-comparison",
        confidence: "derived",
        authority: "analyst-inference",
        parameters: {
          left_evidence_id: left.evidence_id,
          right_evidence_id: right.evidence_id,
          normalization: jsonValueSchema.parse(input.normalization),
          ...(input.origin_pair === undefined
            ? {}
            : { origin_pair: input.origin_pair }),
        },
        result: jsonValueSchema.parse(result),
        evidenceLinks: [...new Set([left.evidence_id, right.evidence_id])],
        limitations: result.limitations,
      }),
    );
  } catch (cause) {
    return err(
      new AnalysisInputError("compare_browser_scenario_evidence", { cause }),
    );
  }
};
