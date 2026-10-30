import { createEvidence, type Evidence } from "../retained/domain/evidence.js";
import { reconstructionPlanInput } from "./contracts.js";

export function planReconstruction(raw: unknown, sources: readonly Evidence[], maxBytes: number): Evidence {
  const plan = reconstructionPlanInput.parse(raw);
  if (Buffer.byteLength(JSON.stringify(plan)) > Math.min(maxBytes, 131072))
    throw new Error("Reconstruction plan exceeds this run's byte budget; split the scope into phases");
  const known = new Set(sources.map((source) => source.evidence_id));
  for (const feature of plan.features)
    for (const reference of feature.evidence_ids)
      if (!known.has(reference)) throw new Error("Plan cites Evidence outside this investigation");
  const unique = (items: readonly { id: string }[], kind: string) => {
    const values = new Set(items.map((item) => item.id));
    if (values.size !== items.length) throw new Error(`Duplicate ${kind} ID`);
    return values;
  };
  const features = unique(plan.features, "feature");
  const components = unique(plan.components, "component");
  const cases = unique(plan.cases, "case");
  const steps = unique(plan.steps, "step");
  const references = (values: readonly string[], known: ReadonlySet<string>, kind: string) => {
    if (new Set(values).size !== values.length || values.some((value) => !known.has(value)))
      throw new Error(`Duplicate or unknown ${kind} reference`);
  };
  for (const component of plan.components) references(component.feature_ids, features, "feature");
  for (const item of plan.cases) references(item.feature_ids, features, "feature");
  for (const step of plan.steps) {
    references(step.feature_ids, features, "feature");
    references(step.component_ids, components, "component");
    references(step.case_ids, cases, "case");
    references(step.depends_on, steps, "step");
    for (const feature of step.feature_ids) {
      if (!step.component_ids.some((id) => plan.components.find((item) => item.id === id)!.feature_ids.includes(feature)))
        throw new Error("Step feature has no matching component responsibility");
      if (!step.case_ids.some((id) => plan.cases.find((item) => item.id === id)!.feature_ids.includes(feature)))
        throw new Error("Step feature has no matching acceptance case");
    }
  }
  for (const id of features)
    if (!plan.steps.some((step) => step.feature_ids.includes(id)))
      throw new Error("Every feature requires an implementation step and acceptance case");
  for (const id of components)
    if (!plan.steps.some((step) => step.component_ids.includes(id)))
      throw new Error("Every component requires an implementation step");
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Implementation dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of plan.steps.find((step) => step.id === id)!.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of steps) visit(id);
  const evidenceIds = [...new Set(plan.features.flatMap((item) => item.evidence_ids))];
  return createEvidence(undefined, { id: "rea-reconstruction-planner", name: "REA reconstruction planning", version: "1" }, {
    operation: "plan_reconstruction", predicateType: "rea.reconstruction-plan",
    parameters: { scope: plan.scope },
    confidence: "inferred", authority: "analyst-inference", evidenceLinks: evidenceIds,
    result: {
      schema_version: 1, interpretation: "inferred", verified: false,
      plan, implementation_order: ordered,
      sources: sources.filter((source) => evidenceIds.includes(source.evidence_id)).map((source) => ({
        evidence_id: source.evidence_id, operation: source.operation,
        confidence: source.confidence, authority: source.authority,
      })),
      acceptance: plan.cases.map((item) => ({ case_id: item.id, state: "not-executed" })),
    },
    limitations: [
      "This is an inferred design proposal. Reference and dependency checks do not validate the meaning or completeness of model claims.",
      "Search snippets and documentation do not establish shipped target behavior. Uncited requirements remain requested or unknown.",
      "No application was built or executed by this operation. Canonical feature obligations and deterministic original/candidate comparisons remain authoritative.",
    ],
  });
}
