import {
  App,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import type { InvestigationRun } from "../src/retained/domain/agentInvestigation.js";
import type { Evidence } from "../src/retained/domain/evidence.js";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import "./workbench.css";
import { FeatureWorkspace } from "./featureWorkspace.js";
import { renderAnalysisGraphs, bindAnalysisGraphs } from "./analysisGraph.js";

const app = new App(
  { name: "REA Investigation Workbench", version: "1.0.0" },
  { availableDisplayModes: ["inline", "fullscreen"] },
);
const standalone = window.parent === window;
let standaloneUrl = "";
let fullscreenBusy = false;
const root = document.querySelector<HTMLDivElement>("#root")!;
type EngineStatus = {
  enabled: boolean;
  models: { analyst: string; reviewer: string | null } | null;
  runs: { run_id: string; question: string; state: string; phase: string }[];
};
let engine: EngineStatus = { enabled: false, models: null, runs: [] };
let session: Record<string, unknown> = {};
const evidence = new Map<string, Evidence>();
const selected = new Set<string>();
let selectedId: string | null = null;
let run: InvestigationRun | null = null;
let unknowns: unknown[] = [];
let view = "overview";
let error = "";
let connected = false;
let busy = false;
let availableModes: string[] = [];
let displayMode = "inline";
let question = "";
let featureAssignment: {
  project_id: string;
  expected_revision: number;
} | null = null;
const formState = {
  review: false,
  functionAnalysis: true,
  webSearch: false,
  target: "",
  workspace: "",
  requests: "8",
  tokens: "2048",
  context: "262144",
  response: "1048576",
  deadline: "120",
  sensitive: "",
  expanded: false,
  specialists: [] as string[],
};
let pathOperation: "import" | "export" | null = null;
let codeFacet = "pseudocode";
let codePage: unknown = null;
let disposed = false;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

const escape = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const unwrap = (value: unknown): Record<string, unknown> => {
  const record = object(value);
  return "result" in record ? object(record.result) : record;
};
const features = new FeatureWorkspace({
  call,
  perform,
  escape,
  unwrap,
  standalone,
  retain: (records) => {
    for (const item of records) addEvidence(item);
  },
  delegate: (project) => {
    featureAssignment = {
      project_id: project.project_id,
      expected_revision: project.revision,
    };
    question = project.definition.goal;
    formState.target = project.definition.original.location;
    formState.workspace =
      project.definition.candidate?.kind === "workspace"
        ? project.definition.candidate.location
        : "";
    selected.clear();
    for (const item of project.definition.evidence_bundle.records) {
      addEvidence(item);
      selected.add(item.evidence_id);
    }
    view = "overview";
  },
  discuss: async (text) => {
    const started = unwrap(
      await call("start_investigation", {
        question: text,
        ...(formState.target ? { target: formState.target } : {}),
        ...(formState.workspace ? { workspace: formState.workspace } : {}),
        ...(featureAssignment ? { feature: featureAssignment } : {}),
        sources: [...selected].map((evidence_id) => ({
          kind: "inline-evidence",
          evidence: evidence.get(evidence_id),
        })),
        review: false,
      }),
    );
    await readRun(String(started.run_id), false);
    view = "overview";
    schedulePoll();
  },
});
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${name === "code" ? '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>' : name === "graph" ? '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h9v9M6 9v9h9"/>' : '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8m-8 4h8m-8 4h5"/>'}</svg>`;
const badge = (text: unknown, color = "violet") =>
  `<span class="badge ${escape(color)}">${escape(text)}</span>`;
const empty = (title: string, detail: string) =>
  `<div class="empty"><strong>${escape(title)}</strong>${escape(detail)}</div>`;
const sourceName = (item: Evidence) => item.operation.replaceAll("_", " ");
const sourceList = () =>
  evidence.size === 0
    ? empty(
        "No evidence collected yet",
        "Select a target and start an internal investigation, or import a canonical bundle.",
      )
    : `<div class="evidence-list">${[...evidence.values()].map((item) => `<div class="evidence-row"><input type="checkbox" data-select="${escape(item.evidence_id)}" aria-label="Include ${escape(sourceName(item))} in investigation" ${selected.has(item.evidence_id) ? "checked" : ""}><div><button data-source="${escape(item.evidence_id)}">${escape(sourceName(item))}</button><small>${escape(item.evidence_id.slice(0, 19))} · ${escape(item.confidence)}</small></div></div>`).join("")}</div>`;
const currentEvidence = () =>
  selectedId === null ? undefined : evidence.get(selectedId);

function report(role: "analyst" | "reviewer"): string {
  const result = run?.[role];
  if (!result) return "";
  return `<section class="report ${role === "reviewer" ? "review" : ""}"><h3>${role === "analyst" ? "Analyst findings" : "Reviewer assessment"} ${badge("Inferred", role === "analyst" ? "violet" : "blue")}</h3>${result.findings.map((finding) => `<p>${escape(finding.claim)}</p><div>${finding.evidence_ids.map((id) => `<button class="cite" data-source="${escape(id)}">${escape(id.slice(0, 19))}</button>`).join("")}</div>${finding.assumptions.length ? `<small>Assumptions: ${escape(finding.assumptions.join("; "))}</small>` : ""}`).join("")}${result.unknowns.length ? `<h3 class="amber">Unresolved questions</h3><ul>${result.unknowns.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}${result.next_steps.length ? `<h3>Suggested next steps</h3><ul>${result.next_steps.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}</section>`;
}

function team(): string {
  return `<section class="panel"><div class="panel-head"><h2>Investigation team</h2>${badge(run?.state ?? "Ready", run?.state === "failed" ? "rose" : "violet")}</div>${engine.runs.length ? `<label for="run-picker">Session investigations</label><select id="run-picker"><option value="">Select a run</option>${engine.runs.map((item) => `<option value="${escape(item.run_id)}" ${item.run_id === run?.run_id ? "selected" : ""}>${escape(item.question.slice(0, 80))} · ${escape(item.state)}</option>`).join("")}</select>` : ""}${(["analyst", "reviewer"] as const).map((role) => `<div class="worker ${role}"><div class="worker-icon">${role === "analyst" ? "A" : "R"}</div><div><h3>${role === "analyst" ? "Code analyst" : "Evidence reviewer"}</h3><small>${escape(engine.models?.[role] ?? "Model not configured")}</small></div><span class="worker-status ${role === "analyst" ? "violet" : "blue"}">${run?.phase === role && run.state === "running" ? "Working" : run?.[role] ? "Reported" : "Idle"}</span></div>`).join("")}<div class="statusline">One scoped assignment · shared Evidence · separate interpretations</div>${run ? `<div class="tabs"><button id="export-report" ${run.state === "running" ? "disabled" : ""}>Export report</button><button id="send-report" ${!connected || run.state === "running" ? "disabled" : ""}>Discuss with main agent</button>${run.state === "running" ? '<button id="cancel-run">Cancel investigation</button>' : ""}</div>` : ""}</section>`;
}

function investigationForm(): string {
  return `<section class="panel"><div class="panel-head"><h2>Delegate a question</h2>${badge(`${selected.size} sources selected`, "blue")}</div><form id="investigation-form"><label for="question">What should REA investigate?</label><textarea id="question" name="question" placeholder="Explain this function’s behavior and identify what the evidence does not establish." required>${escape(question)}</textarea><label for="target">Target path or URL</label><input id="target" value="${escape(formState.target)}" placeholder="Absolute artifact path, app directory, or website URL"><label for="workspace">Output workspace (optional)</label><input id="workspace" value="${escape(formState.workspace)}" placeholder="REA creates a fresh run directory here">${!engine.enabled ? '<div class="notice">Cloud inference is disabled. Configure the analyst model and API key on the REA server to enable the team.</div>' : '<div class="notice">Starting sends this question and selected Evidence to OpenRouter. Local source records remain intact.</div>'}<div class="checks"><label><input id="review" type="checkbox" ${engine.models?.reviewer ? "checked" : "disabled"}> Include reviewer</label><label><input id="function-analysis" type="checkbox"> Run local analysis tools</label><label><input id="web-search" type="checkbox"> Allow public Brave searches (up to 3)</label></div><details><summary>Investigation budgets and sensitive values</summary><div class="budgets"><div><label for="requests">Model requests</label><input id="requests" type="number" min="1" value="8" required></div><div><label for="tokens">Output tokens / request</label><input id="tokens" type="number" min="1" value="2048" required></div><div><label for="context">Context bytes</label><input id="context" type="number" min="1" value="262144" required></div><div><label for="deadline">Deadline, seconds</label><input id="deadline" type="number" min="1" max="2147483" value="120" required></div></div><label for="sensitive">Values to redact from model input, one per line</label><textarea id="sensitive" placeholder="Explicit values only; local Evidence is preserved"></textarea></details><div class="form-end"><small>Reports cite exact Evidence. Model agreement remains an interpretation.</small><button class="primary" type="submit" ${!connected || !engine.enabled || busy || run?.state === "running" ? "disabled" : ""}>${busy || run?.state === "running" ? '<span class="spinner"></span> Investigation running' : "Start investigation"}</button></div></form></section>`;
}

function evidenceDetail(): string {
  const item = currentEvidence();
  return !item
    ? empty(
        "Select an Evidence record",
        "Inspect its source, authority, limitations, and exact results.",
      )
    : `<div class="panel-head"><h2>${escape(sourceName(item))}</h2>${badge(item.confidence, item.confidence === "observed" ? "blue" : "violet")}</div><dl class="source-details"><dt>Evidence ID</dt><dd>${escape(item.evidence_id)}</dd><dt>Provider</dt><dd>${escape(item.provider.name)} · ${escape(item.provider.version ?? "Version unknown")}</dd><dt>Authority</dt><dd>${escape(item.authority)}</dd><dt>Target</dt><dd>${escape(item.subject?.local_path ?? "No target identity")}</dd></dl>${item.limitations.length ? `<div class="notice">${escape(item.limitations.join(" · "))}</div>` : ""}<details open><summary>Normalized result</summary><pre class="code">${escape(JSON.stringify(item.normalized_result, null, 2))}</pre></details><details><summary>Raw provider result</summary><pre class="code">${escape(JSON.stringify(item.raw_result, null, 2))}</pre></details><details><summary>Locations and analysis profile</summary><pre class="code">${escape(JSON.stringify({ locations: item.locations, analysis_profile: item.analysis_profile }, null, 2))}</pre></details>`;
}

function content(): string {
  if (view === "features") return features.render(connected);
  if (view === "overview")
    return `<div class="columns"><div class="stack">${investigationForm()}<section class="panel"><div class="panel-head"><h2>Evidence for this assignment</h2><button id="load-evidence" ${!connected ? "disabled" : ""}>Load session evidence</button></div>${sourceList()}</section></div><div class="stack">${team()}<section class="panel"><div class="panel-head"><h2>Activity</h2><small>${run?.events.length ?? 0} events</small></div>${run?.events.length ? `<ol class="timeline">${run.events.map((event) => `<li><small class="${event.role === "reviewer" ? "blue" : "violet"}">${escape(event.role)}</small>${escape(event.message)}</li>`).join("")}</ol>` : empty("Ready for an assignment", "The team’s actions and reports will appear here.")} ${run?.limitations.map((item) => `<div class="notice">${escape(item)}</div>`).join("") ?? ""}</section></div></div>${run?.analyst || run?.reviewer ? `<section class="panel" style="margin-top:18px">${report("analyst")}${report("reviewer")}</section>` : ""}`;
  if (view === "evidence")
    return `<div class="columns"><section class="panel"><div class="panel-head"><h2>Evidence ledger</h2><button id="load-evidence" ${!connected ? "disabled" : ""}>Refresh</button></div>${sourceList()}<div class="tabs"><button id="import-bundle" ${!connected ? "disabled" : ""}>Import local bundle</button><button id="export-bundle" ${!connected ? "disabled" : ""}>Export local bundle</button></div></section><section class="panel">${evidenceDetail()}</section></div>`;
  if (view === "code")
    return `<div class="columns"><section class="panel"><h2>Code explorer</h2><p class="muted">Select a retained function or application analysis.</p>${sourceList()}<form id="function-form"><label for="procedure">Native symbol or provider address</label><input id="procedure" required placeholder="main or a provider-returned address"><button type="submit" style="margin-top:10px" ${!connected || !engine.enabled || busy ? "disabled" : ""}>Analyze function</button></form></section><section class="panel"><div class="panel-head"><h2>Selected analysis view</h2>${badge("Retained evidence", "blue")}</div><label for="facet">Function facet</label><select id="facet">${["pseudocode", "assembly", "basic_blocks", "callers", "callees", "referenced_strings", "comments"].map((facet) => `<option ${facet === codeFacet ? "selected" : ""}>${facet}</option>`).join("")}</select><div class="tabs"><button id="read-code" ${!connected || !selectedId || busy ? "disabled" : ""}>Read selected facet</button><button id="read-summary" ${!connected || !selectedId || busy ? "disabled" : ""}>Read summary</button></div>${codePage ? `<pre class="code">${escape(JSON.stringify(codePage, null, 2))}</pre>` : empty("No view selected", "Reading a retained view does not rerun its provider.")}</section></div>`;
  if (view === "relationships")
    return `${renderAnalysisGraphs(evidence.values())}<section class="panel"><div class="panel-head"><h2>Evidence provenance</h2>${badge("Explicit source links", "blue")}</div><p class="muted">These relationships are recorded Evidence links. Missing links remain unknown.</p>${evidence.size ? [...evidence.values()].map((item) => `<div class="path"><button data-source="${escape(item.evidence_id)}">${escape(sourceName(item))}</button><p>${escape(item.evidence_id)}</p>${item.evidence_links.length ? item.evidence_links.map((id) => `<button class="cite" data-source="${escape(id)}">Source ${escape(id.slice(0, 19))}</button>`).join("") : "<small>No supporting Evidence links recorded</small>"}</div>`).join("") : empty("No relationship evidence", "Collect source records to explore their provenance.")}</section>`;
  if (view === "comparisons") {
    const items = [...evidence.values()].filter((item) =>
      /compare|changed_behavior|correlate/.test(item.operation),
    );
    return `<section class="panel"><div class="panel-head"><h2>Comparison workspace</h2><button id="discuss-comparison" ${!connected ? "disabled" : ""}>Assign comparison to internal agent</button></div><p class="muted">Inspect comparison workflows returned in chat. Select explicit observation pairs; incomplete coverage remains unresolved.</p>${items.length ? items.map((item) => `<details><summary>${escape(sourceName(item))} · ${escape(item.confidence)}</summary><pre class="code">${escape(JSON.stringify(item.normalized_result, null, 2))}</pre></details>`).join("") : empty("No comparison collected", "Assign an internal investigation to compare selected observations.")}</section>`;
  }
  return `<section class="panel"><div class="panel-head"><h2>Residual unknowns</h2><button id="load-unknowns" ${!connected ? "disabled" : ""}>Refresh unknowns</button></div><p class="muted">Session records preserve revision history and distinguish dispositions from verified truth.</p>${unknowns.length ? unknowns.map((item) => `<details><summary class="amber">${escape(object(item).question ?? object(item).unknown_id ?? "Residual unknown")}</summary><pre class="code">${escape(JSON.stringify(item, null, 2))}</pre></details>`).join("") : empty("No unknown records loaded", "Refresh to inspect the session’s explicit uncertainty ledger.")}${run?.analyst?.unknowns.length ? `<h3 style="margin-top:20px">AI-proposed questions ${badge("Inferred", "amber")}</h3><ul>${run.analyst.unknowns.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}</section>`;
}

function render(): void {
  const focused =
    document.activeElement instanceof HTMLInputElement ||
    document.activeElement instanceof HTMLTextAreaElement
      ? {
          id: document.activeElement.id,
          start: document.activeElement.selectionStart,
          end: document.activeElement.selectionEnd,
        }
      : null;
  if (document.getElementById("investigation-form")) {
    formState.specialists = [
      ...root.querySelectorAll<HTMLInputElement>("[data-specialist]:checked"),
    ].map((item) => item.dataset.specialist!);
    formState.review = (
      document.getElementById("review") as HTMLInputElement
    ).checked;
    formState.functionAnalysis = (
      document.getElementById("function-analysis") as HTMLInputElement
    ).checked;
    formState.webSearch = (document.getElementById("web-search") as HTMLInputElement).checked;
    for (const name of [
      "target",
      "workspace",
      "requests",
      "tokens",
      "context",
      "response",
      "deadline",
      "sensitive",
    ] as const)
      formState[name] = (
        document.getElementById(name) as HTMLInputElement
      ).value;
    formState.expanded =
      document.querySelector<HTMLDetailsElement>("#investigation-form details")
        ?.open ?? false;
  }
  const findings =
    (run?.analyst?.findings.length ?? 0) +
    (run?.reviewer?.findings.length ?? 0);
  root.innerHTML = `<div class="shell"><aside class="rail"><div class="brand"><div class="mark">RE</div><div><strong>REA</strong><div class="eyebrow">Investigation studio</div></div></div><nav class="nav" aria-label="Workbench views">${[
    ["overview", "Investigation"],
    ["features", "Feature workspace"],
    ["evidence", "Evidence ledger"],
    ["code", "Code explorer"],
    ["relationships", "Relationships"],
    ["comparisons", "Comparisons"],
    ["unknowns", "Unknowns"],
  ]
    .map(
      ([id, label]) =>
        `<button data-view="${id}" class="${view === id ? "active" : ""}" ${view === id ? 'aria-current="page"' : ""}>${icon(id === "code" ? "code" : id === "relationships" ? "graph" : "list")}${label}</button>`,
    )
    .join(
      "",
    )}</nav><div class="rail-bottom"><div class="eyebrow">Evidence language</div><div class="legend"><span class="blue"><i class="dot"></i>Observed facts</span><span class="violet"><i class="dot"></i>AI interpretations</span><span class="amber"><i class="dot"></i>Unresolved questions</span><span class="rose"><i class="dot"></i>Failures / contradictions</span></div></div></aside><main><header class="topbar"><div><div class="eyebrow" style="margin-bottom:7px">REA / Workbench</div><h1>${escape(({ overview: "Investigation workspace", features: "Feature workspace", evidence: "Evidence ledger", code: "Code explorer", relationships: "Relationships", comparisons: "Comparisons", unknowns: "Unknowns" } as Record<string, string>)[view] ?? "REA workbench")}</h1></div><div class="actions"><button id="theme">${document.documentElement.dataset.theme === "light" ? "Dark" : "Light"} theme</button><button id="fullscreen" ${!connected || fullscreenBusy ? "disabled" : ""} title="${standalone || availableModes.includes("fullscreen") ? "Toggle fullscreen" : "Open the live workbench in a browser"}">${displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"}</button><button id="refresh" ${!connected || busy ? "disabled" : ""}>Refresh</button></div></header><div class="intro"><div><h2>Follow the evidence. Keep the uncertainty.</h2><p>Internal agents investigate the target with leanrea and installed local tools. Every finding links to Evidence.</p></div>${badge(connected ? (engine.enabled ? "Cloud engine enabled" : "Local analysis · AI disabled") : "Connecting to host", connected ? "blue" : "amber")}</div><div id="error" role="alert">${error ? `<div class="notice error">${escape(error)}</div>` : ""}</div><section class="metrics" aria-label="Investigation summary"><div class="metric"><span>COLLECTED EVIDENCE</span><strong>${evidence.size.toString().padStart(2, "0")}</strong><small>Source observations</small></div><div class="metric"><span>INFERRED FINDINGS</span><strong>${findings.toString().padStart(2, "0")}</strong><small>Analyst + reviewer</small></div><div class="metric"><span>OPEN QUESTIONS</span><strong>${(run?.analyst?.unknowns.length ?? unknowns.length).toString().padStart(2, "0")}</strong><small>Uncertainty stays explicit</small></div><div class="metric"><span>MODEL REQUESTS</span><strong>${(run?.generations.length ?? 0).toString().padStart(2, "0")}</strong><small>${run?.generations.some((item) => item.cost_usd === null) ? "Some costs unknown" : `Reported cost $${(run?.generations.reduce((total, item) => total + (item.cost_usd ?? 0), 0) ?? 0).toFixed(4)}`}</small></div></section>${content()}<footer class="footer"><span>${escape(session.path ?? "No active target")} · ${escape(run ? run.run_id.slice(0, 12) : "No active assignment")}</span><span>Local analysis / optional cloud reasoning</span></footer></main></div>`;
  root
    .querySelector(".budgets")
    ?.insertAdjacentHTML(
      "beforeend",
      '<div><label for="response">Response bytes / request</label><input id="response" type="number" min="1" value="1048576" required></div>',
    );
  root
    .querySelector("#investigation-form .checks")
    ?.insertAdjacentHTML(
      "afterend",
      `<div class="checks">${["planner", "static-analyst", "behavior-analyst"].map((role) => `<label><input type="checkbox" data-specialist="${role}" ${formState.specialists.includes(role) ? "checked" : ""}>${escape(role.replaceAll("-", " "))}</label>`).join("")}</div>${featureAssignment ? `<div class="notice">Durable feature ${escape(featureAssignment.project_id.slice(0, 12))} · revision ${featureAssignment.expected_revision}<button type="button" id="unlink-feature">Use independent assignment</button></div>` : ""}`,
    );
  if (standaloneUrl)
    root
      .querySelector("#error")
      ?.insertAdjacentHTML(
        "beforeend",
        `<div class="notice"><label for="browser-url">Open this live workbench in your browser within 60 seconds</label><input id="browser-url" readonly value="${escape(standaloneUrl)}"><small>The view shares this REA connection. Keep the original chat open.</small></div>`,
      );
  if (standalone)
    root
      .querySelector(".intro")
      ?.insertAdjacentHTML(
        "afterend",
        '<div class="statusline">Browser view · same live REA connection. Use the original chat for host messages and filesystem bundle operations.</div>',
      );
  if (standalone)
    root
      .querySelectorAll<HTMLButtonElement>("#import-bundle, #export-bundle")
      .forEach((button) => {
        button.disabled = true;
        button.title = "Use the original App for filesystem bundle operations";
      });
  if (pathOperation)
    root
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        `<section class="panel bundle-dialog" role="dialog" aria-label="${pathOperation === "import" ? "Import" : "Export"} Evidence bundle"><form id="bundle-form"><h2>${pathOperation === "import" ? "Import local Evidence" : "Export local Evidence"}</h2><label for="bundle-path">Absolute local ${pathOperation === "import" ? "bundle" : "destination"} path</label><input id="bundle-path" required placeholder="C:\\analysis\\evidence.json"><p class="muted">This path is on the REA server computer. Export preserves existing files.</p><div class="tabs"><button type="submit">${pathOperation === "import" ? "Import" : "Export"} bundle</button><button type="button" id="cancel-path">Cancel</button></div></form></section>`,
      );
  bind();
  if (document.getElementById("investigation-form")) {
    (document.getElementById("review") as HTMLInputElement).checked =
      formState.review;
    (document.getElementById("function-analysis") as HTMLInputElement).checked =
      formState.functionAnalysis;
    (document.getElementById("web-search") as HTMLInputElement).checked = formState.webSearch;
    for (const name of [
      "target",
      "workspace",
      "requests",
      "tokens",
      "context",
      "response",
      "deadline",
      "sensitive",
    ] as const)
      (document.getElementById(name) as HTMLInputElement).value =
        formState[name];
    document.querySelector<HTMLDetailsElement>(
      "#investigation-form details",
    )!.open = formState.expanded;
  }
  if (focused?.id) {
    const field = document.getElementById(focused.id);
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      field.focus({ preventScroll: true });
      if (focused.start !== null && focused.end !== null)
        field.setSelectionRange(focused.start, focused.end);
    }
  }
  if (pathOperation && focused?.id !== "bundle-path")
    document.getElementById("bundle-path")?.focus();
}

function addEvidence(raw: unknown): void {
  const item = object(raw);
  if (
    typeof item.evidence_id !== "string" ||
    typeof item.operation !== "string" ||
    !Array.isArray(item.evidence_links) ||
    !Array.isArray(item.limitations) ||
    typeof item.provider !== "object"
  )
    return;
  const record = item as unknown as Evidence;
  evidence.set(record.evidence_id, record);
  if (selectedId === null) selectedId = record.evidence_id;
}
function accept(raw: unknown): void {
  const value = unwrap(raw);
  if ("evidence_id" in value) addEvidence(value);
  if ("engine" in value) {
    engine = value.engine as EngineStatus;
    session = object(value.session);
  }
  if ("run_id" in value && Array.isArray(value.events)) {
    run = value as unknown as InvestigationRun;
    run.sources.forEach(addEvidence);
    const known = engine.runs.find((item) => item.run_id === run!.run_id);
    if (known) {
      known.state = run.state;
      known.phase = run.phase;
    }
  }
}
async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = standalone
    ? await browserCall(name, args)
    : await app.callServerTool({ name, arguments: args });
  if (response.isError) {
    const text =
      response.content
        ?.filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n") ?? "REA tool failed";
    let diagnostic: Record<string, unknown> = {};
    try {
      diagnostic = object(object(JSON.parse(text)).error);
    } catch {
      /* A host may return plain text. */
    }
    const remediation = object(diagnostic.remediation).action;
    throw new Error(
      typeof diagnostic.message === "string"
        ? `${diagnostic.message}${typeof remediation === "string" ? ` ${remediation}` : ""}`
        : text,
    );
  }
  const result =
    response.structuredContent ??
    JSON.parse(
      response.content?.find((item) => item.type === "text")?.text ?? "{}",
    );
  accept(result);
  return result;
}
async function browserCall(name: string, args: Record<string, unknown>) {
  const response = await fetch("/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
  });
  if (!response.ok)
    throw new Error(
      "This browser request is unavailable. Keep the original REA chat connected, or open a fresh browser view from its App.",
    );
  return CallToolResultSchema.parse(await response.json());
}
async function perform(action: () => Promise<void>): Promise<void> {
  error = "";
  busy = true;
  root
    .querySelectorAll<HTMLButtonElement>(
      "button[type=submit], #refresh, #read-code, #read-summary",
    )
    .forEach((button) => {
      button.disabled = true;
    });
  try {
    await action();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "The operation failed";
  } finally {
    busy = false;
    if (!disposed) render();
  }
}
async function refresh(): Promise<void> {
  await call("rea_workbench");
}
async function readRun(
  id: string,
  includeSources: boolean,
): Promise<InvestigationRun> {
  const sources: Evidence[] = [];
  let offset: number | null = 0;
  let latest: InvestigationRun | undefined;
  do {
    const page = unwrap(
      await call("read_investigation", {
        run_id: id,
        include_sources: includeSources,
        source_offset: offset,
        source_limit: 1,
      }),
    );
    latest = page as unknown as InvestigationRun;
    sources.push(...latest.sources);
    offset =
      typeof page.next_source_offset === "number"
        ? page.next_source_offset
        : null;
  } while (includeSources && offset !== null);
  if (includeSources) {
    run = { ...latest!, sources };
  }
  return run!;
}
function schedulePoll(): void {
  clearTimeout(pollTimer);
  if (disposed || !run || run.state !== "running") return;
  pollTimer = setTimeout(() => {
    void perform(async () => {
      const latest = await readRun(run!.run_id, false);
      if (latest.state !== "running") await readRun(latest.run_id, true);
      schedulePoll();
    });
  }, 1500);
}

async function toggleFullscreen(): Promise<void> {
  if (fullscreenBusy) return;
  fullscreenBusy = true;
  document.getElementById("fullscreen")?.setAttribute("disabled", "");
  try {
    if (standalone) {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.fullscreenEnabled)
        await document.documentElement.requestFullscreen();
      else
        throw new Error(
          "Browser fullscreen is unavailable. Maximize this browser window to expand the workbench.",
        );
      displayMode = document.fullscreenElement ? "fullscreen" : "inline";
      return;
    }
    const exiting = displayMode === "fullscreen";
    if (exiting || availableModes.includes("fullscreen")) {
      try {
        const result = await app.requestDisplayMode(
          { mode: exiting ? "inline" : "fullscreen" },
          { timeout: 5000 },
        );
        displayMode = result.mode;
        if (exiting) {
          if (result.mode !== "inline")
            throw new Error(
              "The host kept fullscreen active. Use the host's close or minimize control.",
            );
          return;
        }
        if (result.mode === "fullscreen") return;
      } catch (cause) {
        if (exiting) throw cause;
      }
    }
    const reply = unwrap(
      await call("rea_workbench", {
        open_browser: true,
        handoff: {
          featureWorkspace: features.snapshot(),
          featureAssignment,
          view,
          question,
          form: { ...formState },
          selected: [...selected],
          selectedId,
          runId: run?.run_id ?? null,
          theme: document.documentElement.dataset.theme ?? "dark",
        },
      }),
    );
    if (typeof reply.browser_url !== "string")
      throw new Error(
        "Reconnect to the rebuilt REA server to enable the browser fallback.",
      );
    const url = new URL(reply.browser_url);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/workbench"
    )
      throw new Error("REA returned an invalid browser handoff URL");
    standaloneUrl = url.href;
    if (app.getHostCapabilities()?.openLinks) {
      try {
        const opened = await app.openLink(
          { url: standaloneUrl },
          { timeout: 5000 },
        );
        if (!opened.isError) {
          standaloneUrl = "";
          return;
        }
      } catch {
        /* Retain the copyable handoff when the host denies or times out. */
      }
    }
    error =
      "The host could not open a full-size view. Copy the browser URL below to continue in the same REA session.";
  } finally {
    fullscreenBusy = false;
  }
}

async function connectBrowser(): Promise<void> {
  try {
    const ticket = new URLSearchParams(location.hash.slice(1)).get("handoff");
    // The opaque one-use handoff never reaches HTTP access logs or referrers.
    history.replaceState(null, "", location.pathname);
    if (ticket) {
      const response = await fetch("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok)
        throw new Error(
          "The browser handoff expired or was already used. Open a new view from the original App.",
        );
      const state = object(object(await response.json()).state);
      if (typeof state.question === "string") question = state.question;
      if (typeof state.view === "string") view = state.view;
      if (state.theme === "dark" || state.theme === "light")
        document.documentElement.dataset.theme = state.theme;
      const form = object(state.form);
      for (const key of Object.keys(formState) as (keyof typeof formState)[]) {
        if (typeof form[key] === typeof formState[key])
          Object.assign(formState, { [key]: form[key] });
      }
      if (Array.isArray(state.selected))
        for (const id of state.selected)
          if (typeof id === "string") selected.add(id);
      if (typeof state.selectedId === "string") selectedId = state.selectedId;
      connected = true;
      await refresh();
      await features.restore(state.featureWorkspace);
      const binding = object(state.featureAssignment);
      if (
        typeof binding.project_id === "string" &&
        typeof binding.expected_revision === "number"
      )
        featureAssignment = {
          project_id: binding.project_id,
          expected_revision: binding.expected_revision,
        };
      const bundle = unwrap(await call("get_evidence_bundle"));
      const records = object(bundle.bundle ?? bundle).records;
      if (Array.isArray(records)) records.forEach(addEvidence);
      if (typeof state.runId === "string") await readRun(state.runId, true);
    } else {
      connected = true;
      await refresh();
    }
    document.addEventListener("fullscreenchange", () => {
      displayMode = document.fullscreenElement ? "fullscreen" : "inline";
      render();
    });
    schedulePoll();
  } catch (cause) {
    connected = false;
    error =
      cause instanceof Error ? cause.message : "Browser connection unavailable";
  }
  render();
}
const on = (id: string, action: () => Promise<void> | void) =>
  document.getElementById(id)?.addEventListener("click", () => {
    void perform(async () => {
      await action();
    });
  });
const number = (id: string) =>
  Number((document.getElementById(id) as HTMLInputElement).value);
/** Avoid native form submission so sandboxed hosts need no allow-forms permission. */
function onForm(id: string, action: () => void): void {
  const form = document.getElementById(id) as HTMLFormElement | null;
  if (!form) return;
  const handle = (event: Event) => {
    event.preventDefault();
    if (!busy && form.reportValidity()) action();
  };
  form.addEventListener("submit", handle);
  form
    .querySelector('button[type="submit"]')
    ?.addEventListener("click", handle);
}

function bind(): void {
  bindAnalysisGraphs(render);
  features.bind(root);
  on("unlink-feature", () => {
    featureAssignment = null;
  });
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      view = button.dataset.view!;
      render();
    }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-source]").forEach((button) =>
    button.addEventListener("click", () => {
      selectedId = button.dataset.source!;
      codePage = null;
      if (view !== "code") view = "evidence";
      if (!evidence.has(selectedId))
        error =
          "This linked source is not loaded. Load session evidence or import its bundle.";
      render();
    }),
  );
  root.querySelectorAll<HTMLInputElement>("[data-select]").forEach((input) =>
    input.addEventListener("change", () => {
      if (input.checked) selected.add(input.dataset.select!);
      else selected.delete(input.dataset.select!);
      render();
    }),
  );
  document.getElementById("question")?.addEventListener("input", (event) => {
    question = (event.target as HTMLTextAreaElement).value;
  });
  for (const field of ["target", "workspace"] as const)
    document.getElementById(field)?.addEventListener("input", (event) => {
      formState[field] = (event.target as HTMLInputElement).value;
    });
  on("theme", () => {
    document.documentElement.dataset.theme =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
  });
  on("fullscreen", toggleFullscreen);
  on("refresh", refresh);
  document.getElementById("run-picker")?.addEventListener("change", (event) => {
    const id = (event.target as HTMLSelectElement).value;
    if (id)
      void perform(async () => {
        const restored = await readRun(id, true);
        question = restored.question;
        schedulePoll();
      });
  });
  on("load-evidence", async () => {
    const data = unwrap(await call("get_evidence_bundle"));
    const records = object(data.bundle ?? data).records;
    if (Array.isArray(records)) records.forEach(addEvidence);
    else if (Array.isArray(data.evidence)) data.evidence.forEach(addEvidence);
  });
  on("load-unknowns", async () => {
    const data = unwrap(await call("list_unknowns"));
    unknowns = Array.isArray(data.items) ? data.items : [];
  });
  document.getElementById("facet")?.addEventListener("change", (event) => {
    codeFacet = (event.target as HTMLSelectElement).value;
  });
  const readView = async (summary: boolean) => {
    const item = currentEvidence();
    if (
      item &&
      [
        "run_local_command",
        "read_local_file",
        "list_local_files",
        "prepare_working_copy",
        "write_local_file",
        "local_tool_failure",
      ].includes(item.operation)
    ) {
      codePage = item.normalized_result;
      return;
    }
    const data = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: selectedId },
      view:
        item?.operation.startsWith("inspect_managed_") ||
        item?.operation === "project_managed_application_graph"
          ? summary
            ? { kind: "summary" }
            : {
                kind: "page",
                collection:
                  item.operation === "project_managed_application_graph"
                    ? "nodes"
                    : item.operation === "inspect_managed_artifact"
                      ? "references"
                      : item.operation === "inspect_managed_native_boundaries"
                        ? "pinvoke_imports"
                        : "methods",
                offset: 0,
                limit: 50,
              }
          : item?.operation === "analyze_javascript_application"
            ? summary
              ? { kind: "summary" }
              : { kind: "page", collection: "modules", offset: 0, limit: 50 }
            : summary && item?.operation !== "analyze_function"
              ? { kind: "summary" }
              : { kind: "native", facet: codeFacet, offset: 0, limit: 2048 },
    });
    codePage = object(data).normalized_result;
  };
  on("read-code", () => readView(false));
  on("read-summary", () => readView(true));
  on("cancel-run", async () => {
    await call("cancel_investigation", { run_id: run!.run_id });
    await readRun(run!.run_id, false);
    schedulePoll();
  });
  on("send-report", async () => {
    if (standalone)
      throw new Error(
        `Ask the main agent in the original chat to read investigation ${run!.run_id}.`,
      );
    const response = await app.sendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: `Review REA investigation ${run!.run_id} for: ${run!.question}. Call read_investigation for its complete reports and source Evidence. Distinguish the analyst's interpretations from observed facts and evaluate the reviewer's objections.`,
        },
      ],
    });
    if (response.isError)
      throw new Error(
        "The host rejected the message. Ask the main agent to read this run ID.",
      );
  });
  on("discuss-comparison", async () => {
    const started = unwrap(
      await call("start_investigation", {
        question:
          "Compare these selected observations. Identify compatible dimensions, preserve unsupported coverage and cite exact Evidence.",
        sources: [...selected].map((evidence_id) => ({
          kind: "retained-evidence",
          evidence_id,
        })),
        review: false,
      }),
    );
    await readRun(String(started.run_id), false);
    view = "overview";
    schedulePoll();
  });
  on("export-report", async () => {
    const complete = await readRun(run!.run_id, true);
    if (standalone) {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(complete, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `rea-${complete.run_id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
    const result = await app.downloadFile({
      contents: [
        {
          type: "resource",
          resource: {
            uri: `rea-investigation:${run!.run_id}`,
            mimeType: "application/json",
            text: JSON.stringify(complete, null, 2),
          },
        },
      ],
    });
    if (result.isError)
      throw new Error("The host could not export this report.");
  });
  on("import-bundle", () => {
    pathOperation = "import";
  });
  on("export-bundle", () => {
    pathOperation = "export";
  });
  on("cancel-path", () => {
    pathOperation = null;
  });
  onForm("bundle-form", () => {
    const path = (document.getElementById("bundle-path") as HTMLInputElement)
      .value;
    const operation = pathOperation!;
    void perform(async () => {
      await call(`${operation}_evidence_bundle`, {
        path,
        ...(operation === "export" ? { overwrite: false } : {}),
      });
      if (operation === "import") {
        const data = unwrap(await call("get_evidence_bundle"));
        if (Array.isArray(data.records)) data.records.forEach(addEvidence);
      }
      pathOperation = null;
    });
  });
  onForm("function-form", () => {
    const procedure = (document.getElementById("procedure") as HTMLInputElement)
      .value;
    void perform(async () => {
      const started = unwrap(
        await call("start_investigation", {
          question: `Inspect the native function ${procedure}. Use installed native analysis tools, retain the disassembly or pseudocode and describe the exact coverage.`,
          ...(formState.target ? { target: formState.target } : {}),
          review: false,
          sources: [...selected].map((evidence_id) => ({
            kind: "retained-evidence",
            evidence_id,
          })),
        }),
      );
      await readRun(String(started.run_id), false);
      view = "overview";
      schedulePoll();
    });
  });
  onForm("investigation-form", () => {
    const args = {
      ...(featureAssignment === null ? {} : { feature: featureAssignment }),
      specialists: [
        ...root.querySelectorAll<HTMLInputElement>("[data-specialist]:checked"),
      ].map((item) => item.dataset.specialist!),
      question,
      sources: [...selected].map((evidence_id) =>
        featureAssignment && evidence.has(evidence_id)
          ? { kind: "inline-evidence", evidence: evidence.get(evidence_id)! }
          : { kind: "retained-evidence", evidence_id },
      ),
      review: (document.getElementById("review") as HTMLInputElement).checked,
      ...(formState.target.trim() ? { target: formState.target.trim() } : {}),
      ...(formState.workspace.trim()
        ? { workspace: formState.workspace.trim() }
        : {}),
      allow_commands: (
        document.getElementById("function-analysis") as HTMLInputElement
      ).checked,
      allow_web_search: (document.getElementById("web-search") as HTMLInputElement).checked,
      sensitive_values: (
        document.getElementById("sensitive") as HTMLTextAreaElement
      ).value
        .split(/\r?\n/)
        .filter(Boolean),
      budget: {
        max_requests: number("requests"),
        max_output_tokens: number("tokens"),
        max_context_bytes: number("context"),
        max_response_bytes: number("response"),
        timeout_ms: number("deadline") * 1000,
      },
    };
    void perform(async () => {
      const started = unwrap(await call("start_investigation", args));
      await readRun(String(started.run_id), false);
      await refresh();
      schedulePoll();
    });
  });
}

app.ontoolresult = (result) => {
  if (result.isError)
    error =
      result.content?.find((item) => item.type === "text")?.text ??
      "REA tool failed";
  else {
    const value = unwrap(result.structuredContent);
    if (typeof value.run_id === "string" && !Array.isArray(value.events)) {
      const id = value.run_id;
      void perform(async () => {
        const attached = await readRun(id, false);
        question = attached.question;
        await refresh();
        schedulePoll();
      });
      return;
    }
    accept(result.structuredContent);
  }
  render();
  schedulePoll();
};
app.onhostcontextchanged = (context) => {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  availableModes = context.availableDisplayModes ?? availableModes;
  displayMode = context.displayMode ?? displayMode;
  if (context.safeAreaInsets) {
    const { top, right, bottom, left } = context.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
    document.documentElement.style.setProperty(
      "--rea-safe-height",
      `${top + bottom}px`,
    );
  }
  render();
};
app.onteardown = async () => {
  disposed = true;
  clearTimeout(pollTimer);
  return {};
};
render();
if (standalone) {
  void connectBrowser();
} else
  void app
    .connect()
    .then(async () => {
      connected = true;
      const context = app.getHostContext();
      if (context) app.onhostcontextchanged?.(context);
      await perform(refresh);
    })
    .catch((cause: unknown) => {
      error = `Host connection unavailable: ${cause instanceof Error ? cause.message : "unknown error"}`;
      render();
    });
