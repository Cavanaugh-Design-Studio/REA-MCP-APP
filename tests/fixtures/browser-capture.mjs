// Adapted from morluto/REA's browserScenarioVerification.fixture.ts, MIT.
// Explicit simulated observations; this fixture never launches a browser.
import { createHash } from "node:crypto";
import { browserScenarioSchema } from "../../dist/retained/domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../../dist/retained/domain/browserScenarioCapture.js";
import { createEvidence } from "../../dist/retained/domain/evidence.js";
import { digestCanonicalValue } from "../../dist/retained/domain/canonicalDigest.js";

export function browserCapture({
  text = "same",
  width = 1000,
  missing = false,
  identity = "candidate@1",
} = {}) {
  const url = "http://localhost:4100/";
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "C:/fixture/chrome.exe" },
    start_url: { url, query: [] },
    environment: { viewport: { width, height: 700 } },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
    capture: { after_each_step: ["dom"], at_end: ["dom"] },
  });
  const browserUrl = {
    url,
    origin: new URL(url).origin,
    query_parameter_names: [],
    redacted: false,
  };
  const completeness = {
    status: missing ? "incomplete" : "complete",
    equality_eligible: !missing,
    missing_sections: missing ? ["dom"] : [],
    truncated_sections: [],
  };
  const artifacts = {
    screenshot: { state: "not_requested" },
    dom: missing
      ? { state: "missing", reason: "Simulated missing DOM" }
      : {
          state: "captured",
          value: {
            sha256: createHash("sha256").update(text).digest("hex"),
            bytes: Buffer.byteLength(text),
            text,
          },
        },
    accessibility: { state: "not_requested" },
    url: { state: "not_requested" },
    history: { state: "not_requested" },
    storage: { state: "not_requested" },
  };
  const capture = browserScenarioCaptureSchema.parse({
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "fixture",
      version: "1",
    },
    scenario: {
      start_origin: browserUrl.origin,
      action_count: 1,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
    },
    duration_ms: identity === "original@1" ? 1 : 2,
    steps: [
      {
        step_index: 0,
        step_id: "scenario_start",
        action: "goto_start",
        status: "completed",
        elapsed_ms: 0,
        before_url: browserUrl,
        after_url: browserUrl,
        error: null,
        event_sequence_start: 1,
        event_sequence_end: 0,
        artifacts,
        completeness,
      },
      {
        step_index: 1,
        step_id: "settle",
        action: "wait_for_timeout",
        status: "completed",
        elapsed_ms: 1,
        before_url: browserUrl,
        after_url: browserUrl,
        error: null,
        event_sequence_start: 1,
        event_sequence_end: 0,
        artifacts,
        completeness,
      },
    ],
    events: { retained: 0, dropped: 0, items: [] },
    completeness,
    limitations: [],
  });
  return createEvidence(
    undefined,
    { id: "fixture-browser", name: "Simulated browser", version: "1" },
    {
      operation: "capture_browser_scenario",
      predicateType: "rea.browser-scenario-capture",
      parameters: {
        ...scenario,
        scenario_sha256: digestCanonicalValue(scenario),
      },
      result: capture,
      confidence: "observed",
      authority: "controlled-replay",
      environment: {
        id: "fixture@1",
        platform: "unknown",
        architecture: "unknown",
        isolation: "process",
      },
    },
  );
}
