import { z } from "zod";
import type { InternalTool } from "../contracts.js";

const path = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Path inside this run's working copy; defaults to its selected target",
  );
export const javascriptInput = z.strictObject({ path });
export const managedInput = z.strictObject({
  path,
  facet: z.enum(["identity", "members", "native-boundaries"]),
});
export const nativeInput = z.strictObject({
  path,
  address: z
    .string()
    .regex(/^(?:[A-Za-z0-9_.%-]+:)?0x[0-9a-f]+$/u)
    .optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().max(200).default(50),
});
export const graphInput = z.strictObject({
  evidence_ids: z.array(z.string().min(1)).min(1).max(3),
});
export const browserInput = z.strictObject({
  scenario: z.record(z.string(), z.unknown()),
});
export const deviceInput = z.strictObject({
  serial: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\x00\s"']+$/u),
  capture: z.enum(["screen", "ui", "logcat", "properties"]),
  output_path: z.string().min(1).optional(),
  count: z.number().int().positive().max(10000).default(500),
});
export const viewInput = z.strictObject({
  evidence_id: z.string().min(1),
  view: z.record(z.string(), z.unknown()),
});
export const analysisToolDefinitions: readonly InternalTool[] = [
  {
    name: "analyze_javascript_application",
    description:
      "Parse an inert JavaScript/Electron directory, ASAR or package into canonical module/import/IPC/semantic graphs with source identities and unresolved edges. Executes no target bootstrap.",
    parameters: z.toJSONSchema(javascriptInput),
  },
  {
    name: "inspect_managed_code",
    description:
      "Decode PE/CLR identity, metadata members and CIL, or declared native boundaries from exact file bytes. No CLR loading, external .NET utility or target execution. Select one facet per observation.",
    parameters: z.toJSONSchema(managedInput),
  },
  {
    name: "project_analysis_graph",
    description:
      "Join assigned canonical managed identity/member/native-boundary Evidence into its relationship graph. Exact Evidence IDs only; inferred edges remain inferred. Executes no target.",
    parameters: z.toJSONSchema(graphInput),
  },
  {
    name: "inspect_native_code",
    description:
      "Inspect the selected native working copy with the server-configured Ghidra engine. Without address, page functions; with an exact observed address, obtain pseudocode, assembly, CFG, calls and references. Ephemeral import, owned cleanup, no original target writes.",
    parameters: z.toJSONSchema(nativeInput),
  },
  {
    name: "capture_browser_scenario",
    description:
      "Execute an explicit canonical browser scenario: browser {mode:'launch',executable_path,headless:true}, start_url {url,query:[]}, environment {}, actions [{step_id,action,...}], storage {}, secrets [], capture {after_each_step,at_end,events,network}. Returns authenticated controlled-replay Evidence, not a model report. Use the selected target URL or assigned feature case.",
    parameters: z.toJSONSchema(browserInput),
  },
  {
    name: "capture_device",
    description:
      "Capture one selected Android device's screen PNG, UI XML, bounded logcat or reported properties through server-configured adb. Exact serial required; output_path is an absent file inside this workspace. No app install, emulator startup, device selection or UI input.",
    parameters: z.toJSONSchema(deviceInput),
  },
  {
    name: "inspect_analysis_view",
    description:
      "Inspect a bounded summary/page/item/native facet of an assigned canonical analysis Evidence ID. Managed pages select types, methods, fields, pinvoke_imports, native_implementations, call_edges, field_accesses, references or resources. Graph pages select nodes or edges. Use {kind:'summary'} or {kind:'page',collection,offset,limit}. Full records remain in the workspace's evidence directory.",
    parameters: z.toJSONSchema(viewInput),
  },
];
export const analysisToolNames = new Set(
  analysisToolDefinitions.map((tool) => tool.name),
);
