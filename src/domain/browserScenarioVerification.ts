import { z } from "zod";
import { evidenceSchema, parseEvidence, type Evidence } from "./evidence.js";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { compareBrowserScenarios } from "./browserScenarioDiff.js";
import { compareBrowserScenariosInputSchema } from "./browserScenarioDiffValues.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { browserScenarioSchema } from "./browserScenario.js";

export const BROWSER_SCENARIO_COMPARISON_PROVIDER = {
  id: "rea-browser-scenario-comparison",
  name: "REA browser scenario comparison",
  version: "1",
} as const;
export const browserScenarioEvidenceComparisonInputSchema = z.strictObject({
  left: evidenceSchema,
  right: evidenceSchema,
  normalization: compareBrowserScenariosInputSchema.shape.normalization,
  origin_pair: compareBrowserScenariosInputSchema.shape.origin_pair,
});

export const browserScenarioSource = (raw: unknown): Evidence => {
  const value = parseEvidence(raw);
  if (
    value.operation !== "capture_browser_scenario" ||
    value.predicate_type !== "rea.browser-scenario-capture"
  )
    throw new TypeError(
      "A complete capture_browser_scenario Evidence record is required",
    );
  const capture = browserScenarioCaptureSchema.parse(value.normalized_result);
  const { scenario_sha256, ...rawScenario } = value.parameters;
  const scenario = browserScenarioSchema.parse(rawScenario);
  if (scenario_sha256 !== digestCanonicalValue(scenario, "Browser scenario"))
    throw new TypeError("Browser source scenario commitment disagrees");
  if (
    capture.scenario.start_origin !== new URL(scenario.start_url.url).origin ||
    capture.scenario.action_count !== scenario.actions.length
  )
    throw new TypeError(
      "Browser capture scope disagrees with its selected scenario",
    );
  for (const step of capture.steps) {
    const requested = new Set([
      ...scenario.capture.after_each_step,
      ...(step.step_index === scenario.actions.length
        ? scenario.capture.at_end
        : []),
    ]);
    for (const [kind, artifact] of Object.entries(step.artifacts)) {
      if (
        requested.has(kind as (typeof scenario.capture.at_end)[number]) ===
        (artifact.state === "not_requested")
      )
        throw new TypeError(
          "Browser capture artifact selection disagrees with its scenario input",
        );
    }
    const missing =
      Object.values(step.artifacts).some(
        (artifact) =>
          artifact.state === "missing" || artifact.state === "truncated",
      ) || step.status !== "completed";
    if (
      missing &&
      (step.completeness.equality_eligible ||
        capture.completeness.equality_eligible)
    )
      throw new TypeError(
        "Browser capture completeness contradicts retained observations",
      );
    if (step.step_index === 0) {
      if (step.action !== "goto_start" || step.step_id !== "scenario_start")
        throw new TypeError(
          "Browser capture initial step disagrees with its producer contract",
        );
      continue;
    }
    const action = scenario.actions[step.step_index - 1];
    if (
      !action ||
      action.step_id !== step.step_id ||
      action.action !== step.action
    )
      throw new TypeError(
        "Browser capture step disagrees with its scenario input",
      );
  }
  if (capture.events.dropped > 0 && capture.completeness.equality_eligible)
    throw new TypeError(
      "Dropped browser events cannot establish complete coverage",
    );
  if (
    capture.browser.mode === "connect" &&
    capture.completeness.equality_eligible
  )
    throw new TypeError(
      "Attached browser captures cannot establish launch-time event coverage",
    );
  if (
    digestCanonicalValue(capture.scenario.network_content) !==
    digestCanonicalValue(scenario.capture.network)
  )
    throw new TypeError(
      "Browser capture network selection disagrees with its scenario input",
    );
  if (
    digestCanonicalValue(capture.scenario.secret_references) !==
    digestCanonicalValue(
      scenario.secrets.map((secret) => secret.secret_id).sort(),
    )
  )
    throw new TypeError(
      "Browser capture secret references disagree with its scenario input",
    );
  if (capture.browser.mode !== scenario.browser.mode)
    throw new TypeError(
      "Browser capture mode disagrees with its scenario input",
    );
  for (const event of capture.events.items) {
    if (event.kind !== "network-content") continue;
    const bodyRequested =
      event.phase === "request"
        ? scenario.capture.network.request_body
        : scenario.capture.network.response_body;
    if (
      bodyRequested === (event.body.state === "not_requested") ||
      scenario.capture.network.header_values ===
        (event.headers.state === "not_requested")
    )
      throw new TypeError(
        "Browser network event facet selection disagrees with its scenario input",
      );
  }
  return value;
};

/** Recompute from authenticated source observations, rather than trusting a reported pass. */
export const recomputeBrowserScenarioComparison = (
  comparison: Evidence,
  sources: readonly Evidence[],
) => {
  const left = sources.find(
    (source) => source.evidence_id === comparison.parameters.left_evidence_id,
  );
  const right = sources.find(
    (source) => source.evidence_id === comparison.parameters.right_evidence_id,
  );
  if (!left || !right)
    throw new TypeError(
      "Browser comparison is missing an explicit source side",
    );
  const input = compareBrowserScenariosInputSchema.parse({
    before_scenario: browserScenarioSource(left).normalized_result,
    after_scenario: browserScenarioSource(right).normalized_result,
    normalization: comparison.parameters.normalization,
    ...(comparison.parameters.origin_pair === undefined
      ? {}
      : { origin_pair: comparison.parameters.origin_pair }),
  });
  const computed = compareBrowserScenarios(input);
  if (
    digestCanonicalValue(computed) !==
    digestCanonicalValue(comparison.normalized_result)
  )
    throw new TypeError(
      "Browser comparison disagrees with its source observations",
    );
  return computed;
};
export const browserReplayEnvironmentCompatible = (
  sources: readonly Evidence[],
): boolean =>
  sources.length === 2 &&
  digestCanonicalValue(sources[0]?.parameters.environment) ===
    digestCanonicalValue(sources[1]?.parameters.environment);
