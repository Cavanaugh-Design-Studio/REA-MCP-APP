import { mergeEvidenceBundleProjections } from "../src/domain/evidenceBundleProjection.js";
import { FeatureCaseWorkspace } from "./featureCaseWorkspace.js";
import type { Evidence } from "../src/domain/evidence.js";
import type {
  FeatureProject,
  FeatureDefinition,
} from "../src/domain/featureProject.js";
import type { EvidenceBundle } from "../src/domain/evidenceBundle.js";

import type { FeatureInspection } from "../src/application/features/FeatureProjectService.js";

type Inspection = FeatureInspection;
type Services = {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  perform(action: () => Promise<void>): Promise<void>;
  discuss(text: string): Promise<void>;
  delegate(project: FeatureProject): void;
  retain(records: readonly Evidence[]): void;
  escape(value: unknown): string;
  unwrap(value: unknown): Record<string, unknown>;
  standalone: boolean;
};
type Draft = {
  title: string;
  goal: string;
  original: string;
  candidate: string;
};
type ProjectList = { project_id: string; revision: number; title: string }[];

/** Guided feature state stays separate from source Evidence and authoritative verification. */
export class FeatureWorkspace {
  #items: ProjectList = [];
  #inspection: Inspection | null = null;
  #draft: Draft = { title: "", goal: "", original: "", candidate: "" };
  #definitionDraft = "";
  #definitionBase = "";
  #definitionRevision: number | null = null;
  #output = "";
  #notice = "";
  readonly #cases = new FeatureCaseWorkspace();
  constructor(private readonly services: Services) {}
  snapshot() {
    // The immutable revision owns the manifest and Evidence. Handoff carries
    // only the user's unsaved text change, including temporarily invalid JSON.
    let start = 0;
    while (
      start < this.#definitionBase.length &&
      start < this.#definitionDraft.length &&
      this.#definitionBase[start] === this.#definitionDraft[start]
    )
      start += 1;
    let suffix = 0;
    while (
      suffix < this.#definitionBase.length - start &&
      suffix < this.#definitionDraft.length - start &&
      this.#definitionBase[this.#definitionBase.length - suffix - 1] ===
        this.#definitionDraft[this.#definitionDraft.length - suffix - 1]
    )
      suffix += 1;
    return {
      projectId: this.#inspection?.project.project_id ?? null,
      draft: this.#draft,
      definitionEdit:
        this.#definitionDraft === this.#definitionBase
          ? null
          : {
              start,
              remove: this.#definitionBase.length - start - suffix,
              insert: this.#definitionDraft.slice(
                start,
                this.#definitionDraft.length - suffix,
              ),
            },
      definitionRevision: this.#definitionRevision,
      output: this.#output,
      cases: this.#cases.snapshot(),
    };
  }
  async restore(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const state = raw as Record<string, unknown>;
    const revision =
      typeof state.definitionRevision === "number" &&
      Number.isSafeInteger(state.definitionRevision) &&
      state.definitionRevision > 0
        ? state.definitionRevision
        : undefined;
    if (
      state.definitionEdit !== null &&
      state.definitionEdit !== undefined &&
      (typeof state.projectId !== "string" || revision === undefined)
    )
      throw new Error(
        "The fullscreen manifest edit requires its saved project revision.",
      );
    if (typeof state.projectId === "string")
      await this.load(state.projectId, revision);
    if (typeof state.draft === "object" && state.draft !== null)
      for (const key of Object.keys(this.#draft) as (keyof Draft)[])
        if (typeof Reflect.get(state.draft, key) === "string")
          this.#draft[key] = Reflect.get(state.draft, key) as string;
    if (state.definitionEdit !== null && state.definitionEdit !== undefined) {
      const edit = state.definitionEdit as Record<string, unknown>;
      if (
        typeof edit.start !== "number" ||
        !Number.isSafeInteger(edit.start) ||
        edit.start < 0 ||
        typeof edit.remove !== "number" ||
        !Number.isSafeInteger(edit.remove) ||
        edit.remove < 0 ||
        edit.start + edit.remove > this.#definitionBase.length ||
        typeof edit.insert !== "string"
      )
        throw new Error(
          "The fullscreen manifest edit is invalid. Reopen from the original App.",
        );
      this.#definitionDraft =
        this.#definitionBase.slice(0, edit.start) +
        edit.insert +
        this.#definitionBase.slice(edit.start + edit.remove);
    }
    if (typeof state.output === "string") this.#output = state.output;
    this.#cases.restore(state.cases);
  }
  async load(id: string, revision?: number): Promise<void> {
    this.#inspection = this.services.unwrap(
      await this.services.call("read_feature_project", {
        project_id: id,
        ...(revision === undefined ? {} : { revision }),
      }),
    ) as unknown as Inspection;
    this.#definitionDraft = JSON.stringify(
      this.#inspection.project.definition,
      null,
      2,
    );
    this.#definitionRevision = this.#inspection.project.revision;
    this.#definitionBase = this.#definitionDraft;
    this.services.retain(
      this.#inspection.project.definition.evidence_bundle.records,
    );
    this.#notice = "";
  }
  render(connected: boolean): string {
    const e = this.services.escape;
    const current = this.#inspection;
    const ledger = current?.ledger.normalized_result as
      | Record<string, unknown>
      | undefined;
    const obligations = Array.isArray(ledger?.obligations)
      ? (ledger.obligations as Record<string, unknown>[])
      : [];
    const verification = current?.verification;
    const readiness = current
      ? `<div class="notice"><strong>Feature readiness: ${e(current.readiness.state)}</strong>${current.readiness.reasons.length ? `<ul>${current.readiness.reasons.map((reason) => `<li>${e(reason)}</li>`).join("")}</ul>` : ""}</div>`
      : "";
    const jobs = current?.project.jobs.length
      ? `<section class="panel"><h2>Saved investigations</h2><p class="muted">Each job keeps its assigned feature revision. Reports describe interpretations; verification comes from executed comparisons.</p>${current.project.jobs.map((job) => `<details class="path"><summary><span class="badge ${job.state === "completed" ? "blue" : ["failed", "cancelled", "interrupted"].includes(job.state) ? "rose" : "amber"}">${e(job.state)}</span> ${e(job.job_id)} · feature revision ${job.feature_revision}</summary><p>${e(job.message)}</p>${job.report ? `<p>${job.report.generations.length} model requests</p><pre class="code">${e(JSON.stringify({ specialists: job.report.specialists, analyst: job.report.analyst, reviewer: job.report.reviewer, limitations: job.report.limitations, events: job.report.events }, null, 2))}</pre>` : ""}</details>`).join("")}</section>`
      : "";
    return `<div class="feature-stage"><div><span class="eyebrow">Observe → Specify → Build → Compare → Verify</span><h2>Verified feature workspace</h2><p class="muted">Turn a selected behavior into a working implementation with inspectable proof.</p></div><button id="feature-list" ${connected ? "" : "disabled"}>Open saved projects</button></div><div class="columns"><section class="panel"><div class="panel-head"><h2>Choose the feature</h2><span class="badge blue">Local persistence</span></div>${this.#items.length ? `<label for="feature-picker">Saved projects</label><select id="feature-picker"><option value="">Select a project</option>${this.#items.map((item) => `<option value="${e(item.project_id)}" ${current?.project.project_id === item.project_id ? "selected" : ""}>${e(item.title)} · revision ${item.revision}</option>`).join("")}</select>` : ""}<form id="feature-create"><label for="feature-title">Feature name</label><input id="feature-title" required value="${e(this.#draft.title)}" placeholder="Annotations that survive zoom and reopen"><label for="feature-goal">Behavior to reproduce</label><textarea id="feature-goal" required placeholder="Define what the working result must do">${e(this.#draft.goal)}</textarea><label for="feature-original">Original target path or URL</label><input id="feature-original" required value="${e(this.#draft.original)}"><label for="feature-candidate">Candidate workspace path</label><input id="feature-candidate" value="${e(this.#draft.candidate)}"><p class="muted">Creating saves the current session Evidence locally. Target paths are declarations until supported by observations.</p><button type="submit" class="primary" ${connected ? "" : "disabled"}>Create feature project</button></form>${this.#notice ? `<div class="notice">${e(this.#notice)}</div>` : ""}</section><div class="stack">${current ? `<section class="panel"><div class="panel-head"><h2>${e(current.project.definition.title)}</h2><span class="badge violet">Revision ${current.project.revision}</span></div><p>${e(current.project.definition.goal)}</p>${readiness}<div class="feature-summary"><div><strong>${verification?.summary.passed ?? 0}</strong><small>Verified claims</small></div><div><strong>${verification?.summary.failed ?? 0}</strong><small>Failed claims</small></div><div><strong>${verification?.summary.unknown ?? 0}</strong><small>Unknown claims</small></div></div><div class="notice">${e(verification ? `${verification.status} across ${verification.summary.total} declared claims` : "No finite verification supplied. Define cases and collect comparable observations.")} · Ledger ${e(ledger?.status ?? "unknown")}</div><div class="tabs"><button id="feature-investigate">Prepare investigation</button><button id="feature-refresh">Recheck evidence</button><button id="feature-discuss">Build / repair with main agent</button><button id="feature-download">Download manifest</button></div><small>${e(current.project.project_id)} · ${e(current.sha256.slice(0, 16))}</small></section><section class="panel"><h2>Required behaviors</h2>${obligations.length ? obligations.map((item) => `<div class="path"><span class="badge ${item.status === "verified" ? "blue" : item.status === "contradicted" ? "rose" : "amber"}">${e(item.status)}</span><h3>${e(item.title)}</h3><small>${e(item.obligation_id)}</small><details><summary>Evidence and next action</summary><pre class="code">${e(JSON.stringify(item, null, 2))}</pre></details></div>`).join("") : '<div class="empty"><strong>Success criteria needed</strong>Ask the main agent to characterize the original and add reviewed obligations, cases and owner bindings.</div>'}${verification?.claims.items.map((item) => `<div class="path"><span class="badge ${item.status === "pass" ? "blue" : item.status === "fail" ? "rose" : "amber"}">${e(item.status)}</span><strong>${e(item.claim_id)}</strong><p>${e(item.limitations.join(" · "))}</p>${item.evidence_links.map((id) => `<button class="cite" data-source="${e(id)}">${e(id.slice(0, 19))}</button>`).join("")}</div>`).join("") ?? ""}</section>${jobs}${this.#cases.render(current.project, e)}` : '<section class="panel empty"><strong>One feature. Explicit proof.</strong>Create or open a saved project to define requirements, inspect gaps and deliver a verified handoff.</section>'}</div></div>${current ? `<section class="panel feature-editor"><div class="panel-head"><h2>Cases and implementation bindings</h2><span class="badge amber">Explicit revision</span></div><p class="muted">The manifest preserves exact scenario inputs, canonical obligations and Evidence. The main agent can update it through MCP; advanced users can edit the complete definition here.</p><form id="feature-revise"><details><summary>Edit complete feature definition</summary><textarea id="feature-definition" class="manifest-editor" spellcheck="false">${e(this.#definitionDraft)}</textarea></details><div class="tabs"><button type="submit">Save next revision</button><button type="button" id="feature-attach">Attach current session Evidence</button></div></form><form id="feature-export"><label for="feature-output">Absent absolute handoff directory</label><input id="feature-output" value="${e(this.#output)}" placeholder="C:\\analysis\\annotation-handoff"><button type="submit" ${this.services.standalone ? "disabled title='Export from the original App or CLI'" : ""}>Export specification, cases and report</button></form></section>` : ""}`;
  }
  bind(root: HTMLElement): void {
    const s = this.services;
    const click = (id: string, run: () => Promise<void>) =>
      root.querySelector(`#${id}`)?.addEventListener("click", () => {
        void s.perform(run);
      });
    const submit = (id: string, run: () => Promise<void>) => {
      const form = root.querySelector<HTMLFormElement>(`#${id}`);
      if (!form) return;
      const handle = (event: Event) => {
        event.preventDefault();
        if (form.reportValidity()) void s.perform(run);
      };
      form.addEventListener("submit", handle);
      form
        .querySelector('button[type="submit"]')
        ?.addEventListener("click", handle);
    };
    for (const key of Object.keys(this.#draft) as (keyof Draft)[])
      root
        .querySelector(`#feature-${key}`)
        ?.addEventListener("input", (event) => {
          this.#draft[key] = (event.target as HTMLInputElement).value;
        });
    root
      .querySelector("#feature-definition")
      ?.addEventListener("input", (event) => {
        this.#definitionDraft = (event.target as HTMLTextAreaElement).value;
      });
    root
      .querySelector("#feature-output")
      ?.addEventListener("input", (event) => {
        this.#output = (event.target as HTMLInputElement).value;
      });
    root
      .querySelector("#feature-picker")
      ?.addEventListener("change", (event) => {
        const id = (event.target as HTMLSelectElement).value;
        if (id) void s.perform(() => this.load(id));
      });
    click("feature-list", async () => {
      const result = s.unwrap(await s.call("list_feature_projects"));
      this.#items = result.items as ProjectList;
    });
    submit("feature-create", async () => {
      const raw = s.unwrap(await s.call("get_evidence_bundle"));
      const bundle = (raw.bundle ?? raw) as EvidenceBundle;
      const definition: FeatureDefinition = {
        title: this.#draft.title,
        goal: this.#draft.goal,
        original: {
          kind: /^https?:\/\//u.test(this.#draft.original)
            ? "browser"
            : "artifact",
          location: this.#draft.original,
          sha256: null,
        },
        candidate: this.#draft.candidate
          ? { kind: "workspace", location: this.#draft.candidate, sha256: null }
          : null,
        evidence_bundle: bundle,
        obligations: {
          reviewed_obligations: [],
          manifest: { bindings: [], contradictions: [] },
        },
        specification: null,
        cases: [],
        notes: [],
      };
      const created = s.unwrap(
        await s.call(
          "create_feature_project",
          definition as unknown as Record<string, unknown>,
        ),
      ) as unknown as FeatureProject;
      await this.load(created.project_id);
    });
    click("feature-refresh", async () => {
      if (this.#inspection)
        await this.load(this.#inspection.project.project_id);
    });
    click("feature-investigate", async () => {
      this.services.delegate(this.#inspection!.project);
    });
    const revise = async (definition: unknown) => {
      const current = this.#inspection!.project;
      await s.call("revise_feature_project", {
        project_id: current.project_id,
        expected_revision: this.#definitionRevision ?? current.revision,
        definition,
      });
      await this.load(current.project_id);
    };
    if (this.#inspection)
      this.#cases.bind(root, this.#inspection.project, {
        call: s.call,
        perform: s.perform,
        revise,
        discuss: s.discuss,
        unwrap: s.unwrap,
      });
    submit("feature-revise", () => revise(JSON.parse(this.#definitionDraft)));
    click("feature-attach", async () => {
      const raw = s.unwrap(await s.call("get_evidence_bundle"));
      const definition = JSON.parse(this.#definitionDraft) as FeatureDefinition;
      definition.evidence_bundle = mergeEvidenceBundleProjections(
        definition.evidence_bundle,
        (raw.bundle ?? raw) as EvidenceBundle,
      );
      await revise(definition);
    });
    submit("feature-export", async () => {
      const project = this.#inspection!.project;
      await s.call("export_feature_handoff", {
        project_id: project.project_id,
        revision: project.revision,
        output_directory: this.#output,
      });
      this.#notice = `Complete handoff exported to ${this.#output}`;
    });
    click("feature-discuss", async () => {
      const project = this.#inspection!.project;
      await s.discuss(
        `Continue REA feature project ${project.project_id}, revision ${project.revision}. Read it with read_feature_project. Characterize the original, add finite reviewed obligations and cases, build in its selected candidate workspace, compare independent original/candidate observations, fix supported divergences and retain verification Evidence. Preserve unknowns and report exactly which behavior is verified.`,
      );
    });
    click("feature-download", async () => {
      const project = this.#inspection!.project;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(project, null, 2)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `rea-feature-${project.project_id}-r${project.revision}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }
}
