import type {
  FeatureProject,
  FeatureDefinition,
} from "../src/retained/domain/featureProject.js";
import type { Evidence } from "../src/retained/domain/evidence.js";
import type { BrowserScenario } from "../src/retained/domain/browserScenario.js";
import type { BrowserScenarioDiff } from "../src/retained/domain/browserScenarioDiffValues.js";
import { mergeEvidenceBundleProjections } from "../src/retained/domain/evidenceBundleProjection.js";
import type { EvidenceBundle } from "../src/retained/domain/evidenceBundle.js";

type Services = {
  call(name: string, input?: Record<string, unknown>): Promise<unknown>;
  unwrap(value: unknown): Record<string, unknown>;
  perform(action: () => Promise<void>): Promise<void>;
  revise(definition: FeatureDefinition): Promise<void>;
  discuss(message: string): Promise<void>;
};
type Draft = {
  id: string;
  title: string;
  obligation: string;
  left: string;
  right: string;
  normalization: string;
  kind: string;
};
const record = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
const captures = (project: FeatureProject): Evidence[] =>
  project.definition.evidence_bundle.records.filter(
    (item) =>
      item.operation === "capture_browser_scenario" &&
      item.predicate_type === "rea.browser-scenario-capture",
  );
const scenario = (source: Evidence): BrowserScenario => {
  const { scenario_sha256: _commitment, ...input } = source.parameters;
  return input as unknown as BrowserScenario;
};

/** UI selection composes existing capture and comparison contracts; the server owns validation. */
export class FeatureCaseWorkspace {
  #selected = "";
  #draft: Draft = {
    id: "",
    title: "",
    obligation: "",
    left: "",
    right: "",
    normalization: '{"rules": []}',
    kind: "positive",
  };
  snapshot() {
    return { selected: this.#selected, draft: this.#draft };
  }
  restore(raw: unknown): void {
    const state = record(raw);
    if (typeof state.selected === "string") this.#selected = state.selected;
    const draft = record(state.draft);
    for (const key of Object.keys(this.#draft) as (keyof Draft)[])
      if (typeof draft[key] === "string") this.#draft[key] = draft[key];
  }
  render(project: FeatureProject, e: (value: unknown) => string): string {
    const available = captures(project);
    const options = (selected: string) =>
      '<option value="">Choose a retained capture</option>' +
      available
        .map(
          (item) =>
            `<option value="${e(item.evidence_id)}" ${item.evidence_id === selected ? "selected" : ""}>${e(scenario(item).start_url?.url)} · ${e(item.evidence_id.slice(0, 19))}</option>`,
        )
        .join("");
    const cases = project.definition.cases;
    const selected =
      cases.find((item) => item.case_id === this.#selected) ?? cases[0];
    const proof = selected ? this.#comparison(project, selected.claim_ids) : "";
    return `<section class="panel feature-cases"><div class="panel-head"><h2>Executed case timeline</h2><span class="badge blue">${cases.length} declared cases</span></div><p class="muted">Select retained original and candidate captures to create an exact case. Capture runs remain explicit actions through internal agents.</p><button id="feature-capture-request">Request original / candidate capture</button>${cases.length ? `<label for="feature-case-picker">Case to inspect</label><select id="feature-case-picker">${cases.map((item) => `<option value="${e(item.case_id)}" ${item.case_id === selected?.case_id ? "selected" : ""}>${e(item.title)}</option>`).join("")}</select><div class="columns"><div><h3>Original actions</h3>${this.#timeline(selected!.original, e)}</div><div><h3>Candidate actions</h3>${this.#timeline(selected!.candidate, e)}</div></div>${this.#results(project, selected!.claim_ids, e)}${proof ? `<details><summary>Retained comparison and normalization</summary><pre class="code">${e(proof)}</pre></details>` : '<div class="notice">No comparable Evidence is bound to this case yet.</div>'}` : '<div class="empty"><strong>No cases executed</strong>Assign internal agents to capture a distinguishing input on both targets, then attach the session Evidence.</div>'}<details><summary>Add a case from browser captures</summary><form id="feature-case-create"><div class="columns"><div><label for="feature-case-id">Stable case ID</label><input id="feature-case-id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" value="${e(this.#draft.id)}"><label for="feature-case-title">Case behavior</label><input id="feature-case-title" required value="${e(this.#draft.title)}"><label for="feature-case-obligation">Reviewed obligation</label><select id="feature-case-obligation" required><option value="">Choose a required behavior</option>${project.definition.obligations.reviewed_obligations.map((item) => `<option value="${e(item.obligation_id)}" ${item.obligation_id === this.#draft.obligation ? "selected" : ""}>${e(item.title)}</option>`).join("")}</select></div><div><label for="feature-case-kind">Case kind</label><select id="feature-case-kind" required>${["positive", "negative", "malformed", "cancellation", "teardown"].map((kind) => `<option value="${kind}" ${kind === this.#draft.kind ? "selected" : ""}>${kind}</option>`).join("")}</select><label for="feature-case-left">Original capture</label><select id="feature-case-left" required>${options(this.#draft.left)}</select><label for="feature-case-right">Candidate capture</label><select id="feature-case-right" required>${options(this.#draft.right)}</select><label for="feature-case-normalization">Explicit literal normalization JSON</label><textarea id="feature-case-normalization" spellcheck="false">${e(this.#draft.normalization)}</textarea></div></div><p class="muted">No origins or output values are normalized automatically. Comparison can pass, fail or remain unknown. This records a finite claim; obligation authority and owner bindings are evaluated separately.</p><button type="submit" ${available.length < 2 ? "disabled" : ""}>Compare and save case</button></form></details></section>`;
  }
  #timeline(
    value: FeatureDefinition["cases"][number]["original"],
    e: (value: unknown) => string,
  ): string {
    const entries =
      value.kind === "browser" ? value.input.actions : value.input.events;
    return `<ol class="case-timeline">${entries.map((entry) => `<li><pre class="code">${e(JSON.stringify(entry, null, 2))}</pre></li>`).join("")}</ol>`;
  }
  #comparison(project: FeatureProject, claims: string[]): string {
    return JSON.stringify(
      project.definition.specification?.claims
        .filter((claim) => claims.includes(claim.claim_id))
        .map((claim) => ({
          claim,
          evidence: project.definition.evidence_bundle.records.find(
            (item) => item.evidence_id === claim.comparison_evidence_id,
          ),
        })) ?? [],
      null,
      2,
    );
  }
  #results(
    project: FeatureProject,
    claims: string[],
    e: (value: unknown) => string,
  ): string {
    const records = new Map(
      project.definition.evidence_bundle.records.map((item) => [
        item.evidence_id,
        item,
      ]),
    );
    return (project.definition.specification?.claims ?? [])
      .filter(
        (claim) =>
          claims.includes(claim.claim_id) && claim.kind === "browser-behavior",
      )
      .map((claim) => {
        const source = records.get(claim.comparison_evidence_id);
        if (!source) return "";
        const diff = source.normalized_result as unknown as BrowserScenarioDiff;
        if (diff.comparison_kind !== "browser_scenario") return "";
        const sides = [
          records.get(String(source.parameters.left_evidence_id)),
          records.get(String(source.parameters.right_evidence_id)),
        ];
        const observation = (side: Evidence | undefined) =>
          side ? record(side.normalized_result).steps : null;
        return `<div class="notice"><strong>Comparison: ${e(diff.overall_status)}</strong> · ${e(diff.alignment.status)} step alignment</div><table class="case-deltas"><thead><tr><th>Step</th><th>Result</th><th>Changed / incomplete facets</th></tr></thead><tbody>${diff.steps.map((step) => `<tr><td>${e(step.step_id)}</td><td><span class="badge ${step.status === "unchanged" ? "blue" : step.status === "changed" ? "rose" : "amber"}">${e(step.status)}</span></td><td>${e(step.artifact_diffs.map((item) => `${item.artifact}: ${item.reason ?? item.status}`).join(" · ") || "Selected facets match")}</td></tr>`).join("")}</tbody></table><div class="columns"><details><summary>Original retained step observations</summary><pre class="code">${e(JSON.stringify(observation(sides[0]), null, 2))}</pre></details><details><summary>Candidate retained step observations</summary><pre class="code">${e(JSON.stringify(observation(sides[1]), null, 2))}</pre></details></div>`;
      })
      .join("");
  }
  bind(root: HTMLElement, project: FeatureProject, services: Services): void {
    const picker = root.querySelector<HTMLSelectElement>(
      "#feature-case-picker",
    );
    picker?.addEventListener("change", () => {
      this.#selected = picker.value;
      void services.perform(async () => {});
    });
    root
      .querySelector("#feature-capture-request")
      ?.addEventListener("click", () => {
        void services.perform(() =>
          services.discuss(
            `Read REA feature project ${project.project_id}, revision ${project.revision}. Propose a distinguishing browser/process scenario for one required behavior, preserve exact caller-selected inputs, and execute separately scoped original/candidate captures using installed local tools. Retain the Evidence and attach it to this feature. Do not claim equivalence from screenshots or model agreement alone.`,
          ),
        );
      });
    for (const key of Object.keys(this.#draft) as (keyof Draft)[]) {
      const input = root.querySelector<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >(`#feature-case-${key}`);
      input?.addEventListener("input", () => {
        this.#draft[key] = input.value;
      });
      input?.addEventListener("change", () => {
        this.#draft[key] = input.value;
      });
    }
    const form = root.querySelector<HTMLFormElement>("#feature-case-create");
    const submit = (event: Event) => {
      event.preventDefault();
      if (form?.reportValidity())
        void services.perform(() => this.#create(project, services));
    };
    form?.addEventListener("submit", submit);
    form
      ?.querySelector('button[type="submit"]')
      ?.addEventListener("click", submit);
  }
  async #create(project: FeatureProject, services: Services): Promise<void> {
    const draft = this.#draft;
    if (project.definition.cases.some((item) => item.case_id === draft.id))
      throw new Error(
        "Choose a new case ID; edit an existing case in the manifest.",
      );
    if (draft.left === draft.right)
      throw new Error(
        "Original and candidate must be independently captured observations.",
      );
    const available = captures(project);
    const left = available.find((item) => item.evidence_id === draft.left);
    const right = available.find((item) => item.evidence_id === draft.right);
    if (!left || !right)
      throw new Error("Select two retained browser captures.");
    const leftInput = scenario(left),
      rightInput = scenario(right);
    const comparison = await services.call(
      "compare_browser_scenario_evidence",
      {
        left,
        right,
        origin_pair: {
          before_origin: new URL(leftInput.start_url.url).origin,
          after_origin: new URL(rightInput.start_url.url).origin,
        },
        normalization: JSON.parse(draft.normalization),
      },
    );
    const evidence = comparison as Evidence;
    const raw = services.unwrap(await services.call("get_evidence_bundle"));
    const bundle = (raw.bundle ?? raw) as EvidenceBundle;
    const definition = structuredClone(project.definition);
    definition.evidence_bundle = mergeEvidenceBundleProjections(
      definition.evidence_bundle,
      bundle,
    );
    definition.cases.push({
      case_id: draft.id,
      title: draft.title,
      obligation_ids: [draft.obligation],
      claim_ids: [draft.id],
      case_kind: (() => {
        const kinds = [
          "positive",
          "negative",
          "malformed",
          "cancellation",
          "teardown",
        ] as const;
        const kind = kinds.find((value) => value === draft.kind);
        if (!kind) throw new Error("Choose an explicit case kind.");
        return kind;
      })(),
      original: { kind: "browser", input: leftInput },
      candidate: { kind: "browser", input: rightInput },
    });
    definition.specification ??= { name: definition.title, claims: [] };
    if (
      definition.specification.claims.some((item) => item.claim_id === draft.id)
    )
      throw new Error("The case ID already belongs to a different claim.");
    definition.specification.claims.push({
      claim_id: draft.id,
      title: draft.title,
      kind: "browser-behavior",
      dimension: "overall",
      comparison_evidence_id: evidence.evidence_id,
    });
    await services.revise(definition);
    this.#selected = draft.id;
  }
}
