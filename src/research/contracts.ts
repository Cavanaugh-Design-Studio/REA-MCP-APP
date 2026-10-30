import { z } from "zod";
import type { InternalTool } from "../contracts.js";

const text = z.string().min(1).max(2000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const ids = z.array(id).max(60);
export const webSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(600).refine((value) => value.split(/\s+/u).length <= 75, "Maximum 75 query words"),
  count: z.number().int().min(1).max(10).default(5),
  offset: z.number().int().min(0).max(9).default(0),
  freshness: z.enum(["pd", "pw", "pm", "py"]).optional(),
});
export const reconstructionPlanInput = z.strictObject({
  scope: z.enum(["feature", "application"]),
  goal: text,
  features: z.array(z.strictObject({
    id, behavior: text,
    evidence_ids: z.array(z.string().regex(/^ev_[a-f0-9]{64}$/u)).max(20),
    assumptions: z.array(text).max(10),
  })).min(1).max(30),
  components: z.array(z.strictObject({
    id, responsibility: text, feature_ids: ids.min(1),
    interfaces: z.array(text).min(1).max(10), state: z.array(text).max(10),
  })).min(1).max(20),
  cases: z.array(z.strictObject({
    id, feature_ids: ids.min(1),
    kind: z.enum(["positive", "negative", "malformed", "cancellation", "teardown"]),
    input: text, expected: text,
  })).min(1).max(60),
  steps: z.array(z.strictObject({
    id, action: text, component_ids: ids.min(1), feature_ids: ids.min(1),
    depends_on: ids, case_ids: ids.min(1),
  })).min(1).max(40),
  unknowns: z.array(text).max(30),
});

export const researchToolDefinitions: readonly InternalTool[] = [
  {
    name: "search_web",
    description: "Search Brave for public technical documentation. Requires server-side BRAVE_SEARCH_API_KEY and caller allow_web_search. Returns external-service Evidence with URLs, snippets and timestamps; snippets do not prove target behavior. Never send secrets or private source. Does not fetch result pages.",
    parameters: z.toJSONSchema(webSearchInput),
  },
  {
    name: "plan_reconstruction",
    description: "Validate and retain your feature/application reconstruction blueprint: Evidence-linked behaviors, components/interfaces/state, dependency-ordered implementation steps and observable acceptance cases. Cite only assigned Evidence; list assumptions/unknowns. Every feature needs a step and case. All design claims remain inferred; this tool neither builds nor verifies an app. Use existing write_file/run_command and feature contracts for implementation and deterministic comparison.",
    parameters: z.toJSONSchema(reconstructionPlanInput),
  },
];
