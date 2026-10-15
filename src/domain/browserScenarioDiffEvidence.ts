import type {
  BrowserScenarioCompleteness,
  BrowserScenarioCompletenessSection,
  BrowserScenarioStep,
  BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";
import type { BrowserScenarioCapture } from "./browserScenarioCapture.js";
import type {
  BrowserScenarioArtifactKind,
  BrowserScenarioEvidenceState,
} from "./browserScenarioDiffValues.js";

/** Capture-state input consumed by browser scenario artifact comparison. */
export type CaptureState<Value> =
  | { readonly state: "captured"; readonly value: Value }
  | { readonly state: "not_requested" }
  | { readonly state: "missing"; readonly reason: string }
  | {
      readonly state: "truncated";
      readonly observed: number;
      readonly retained: number;
      readonly reason: string;
    };

const includesCompletenessSection = (
  completeness: BrowserScenarioCompleteness,
  collection: "missing_sections" | "truncated_sections",
  section: BrowserScenarioCompletenessSection,
): boolean => {
  const sections: readonly BrowserScenarioCompletenessSection[] =
    completeness[collection];
  return sections.includes(section);
};

/** Project one captured artifact through its step-level completeness ledger. */
export const artifactEvidenceState = <Value>(
  artifact: BrowserScenarioArtifactKind,
  state: CaptureState<Value>,
  step: BrowserScenarioStep,
): BrowserScenarioEvidenceState => {
  if (state.state !== "captured") return state.state;
  const section = artifact === "action_state" ? "action" : artifact;
  if (
    includesCompletenessSection(
      step.completeness,
      "truncated_sections",
      section,
    )
  )
    return "truncated";
  return includesCompletenessSection(
    step.completeness,
    "missing_sections",
    section,
  )
    ? "missing"
    : "captured";
};

const EVENT_SECTIONS = [
  "events",
  "frames",
  "workers",
  "popups",
  "websockets",
] as const;

const attributedEvents = (
  capture: BrowserScenarioCapture,
  stepIndex: number,
) => {
  const sourceSteps = new Map(
    capture.events.items.map((event) => [event.sequence, event.step_index]),
  );
  return capture.events.items.filter(
    (event) =>
      (event.kind === "network-content"
        ? sourceSteps.get(event.source_event_sequence)
        : event.step_index) === stepIndex,
  );
};

/** Project event evidence through capture- and step-level completeness. */
export const eventEvidenceState = (
  capture: BrowserScenarioCapture,
  step: BrowserScenarioStep,
): BrowserScenarioEvidenceState => {
  const retained = attributedEvents(capture, step.step_index);
  if (
    retained.some(
      (event) =>
        (event.kind === "websocket-frame-sent" ||
          event.kind === "websocket-frame-received") &&
        event.truncated,
    )
  )
    return "truncated";
  if (
    retained.some(
      (event) =>
        event.kind === "request-unfinished" ||
        (event.kind === "network-content" &&
          (event.body.state === "unavailable" ||
            event.body.state === "not_exposed" ||
            event.headers.state === "unavailable" ||
            (event.body.state === "captured" && event.body.redacted) ||
            (event.headers.state === "captured" &&
              event.headers.items.some((header) => header.redacted)))),
    )
  )
    return "missing";
  const listed = (collection: "missing_sections" | "truncated_sections") =>
    EVENT_SECTIONS.some(
      (section) =>
        includesCompletenessSection(
          capture.completeness,
          collection,
          section,
        ) ||
        includesCompletenessSection(step.completeness, collection, section),
    );
  if (capture.events.dropped > 0 || listed("truncated_sections"))
    return "truncated";
  return listed("missing_sections") ? "missing" : "captured";
};

/** Select stable action fields for normalized comparison. */
export const actionState = (step: BrowserScenarioStep) => ({
  action: step.action,
  status: step.status,
  before_url: step.before_url,
  after_url: step.after_url,
  error: step.error,
});

/** Select events attributed to one scenario step without sequence metadata. */
export const eventsFor = (
  capture: BrowserScenarioCapture,
  stepIndex: number,
): readonly unknown[] => {
  return attributedEvents(capture, stepIndex).map(
    ({ sequence: _sequence, step_index: _stepIndex, ...event }) => {
      if (event.kind === "network-content") {
        const { source_event_sequence: _sourceSequence, ...content } = event;
        return content;
      }
      return event;
    },
  );
};

/** Different content selection is missing comparability, not an observed website change. */
export const networkContentCoverageReason = (
  before: BrowserScenarioCapture,
  after: BrowserScenarioCapture,
): string | undefined => {
  const left = before.scenario.network_content;
  const right = after.scenario.network_content;
  return left.request_body !== right.request_body ||
    left.response_body !== right.response_body ||
    left.header_values !== right.header_values
    ? "Network content selections differ; capture both sides with matching content selection before comparing network evidence."
    : undefined;
};

/** Wrap one value as captured comparison evidence. */
export const captured = <Value>(value: Value): CaptureState<Value> => ({
  state: "captured",
  value,
});

/** Retain stable screenshot identity without embedding image bytes. */
export const screenshotProjection = (
  screenshot: Extract<
    BrowserStepArtifacts["screenshot"],
    { state: "captured" }
  >["value"],
) => ({
  sha256: screenshot.sha256,
  bytes: screenshot.bytes,
  media_type: screenshot.media_type,
});
