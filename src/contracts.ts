import { z } from "zod";
import { investigationInputSchema } from "./retained/domain/agentInvestigation.js";

export const taskInputSchema = investigationInputSchema
  .omit({ allow_function_analysis: true })
  .extend({
    target: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute local artifact/directory path or explicit website URL to investigate",
      ),
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Absolute directory under which REA creates a fresh owned run workspace",
      ),
    allow_commands: z.boolean().default(true),
    allow_web_search: z.boolean().default(false).describe("Allow public search queries to Brave; requires server-side BRAVE_SEARCH_API_KEY. Never send private source or secrets."),
    max_web_searches: z.number().int().min(1).max(20).default(3),
    max_copy_bytes: z.number().int().positive().default(1073741824),
    review: z.boolean().default(false),
  });
export type TaskInput = z.infer<typeof taskInputSchema>;

export const readInputSchema = z.strictObject({
  run_id: z.string().min(1),
  include_sources: z.boolean().default(false),
  source_offset: z.number().int().nonnegative().default(0),
  source_limit: z.number().int().positive().default(1),
});
export const runIdSchema = z.strictObject({ run_id: z.string().min(1) });
export const workbenchInputSchema = z.strictObject({
  open_browser: z.boolean().optional(),
  handoff: z.record(z.string(), z.unknown()).optional(),
});

export const runCommandSchema = z.strictObject({
  executable: z.string().min(1),
  arguments: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().max(2147483647).default(30000),
  max_output_bytes: z.number().int().positive().default(131072),
});
export const readFileSchema = z.strictObject({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().default(16384),
});
export const writeFileSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
  expected_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const listFilesSchema = z.strictObject({
  path: z.string().default("."),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(100),
});

export type InternalToolName =
  | "run_command"
  | "read_file"
  | "write_file"
  | "list_files"
  | "inspect_analysis_view"
  | "analyze_javascript_application"
  | "inspect_managed_code"
  | "project_analysis_graph"
  | "inspect_native_code"
  | "capture_browser_scenario"
  | "capture_device"
  | "search_web"
  | "plan_reconstruction";
export interface InternalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export const localToolDefinitions: readonly InternalTool[] = [
  {
    name: "run_command",
    description:
      "Run a caller-installed analysis utility with exact argv in this investigation's working copy. Returns observed output, exit status and owned cleanup. Use the current platform's shell executable explicitly for pipelines. Do not install software or alter original targets.",
    parameters: z.toJSONSchema(runCommandSchema),
  },
  {
    name: "read_file",
    description:
      "Read an exact byte slice from the owned workspace, recording its complete-file digest, offset and coverage. Use for focused source, disassembly or saved output inspection.",
    parameters: z.toJSONSchema(readFileSchema),
  },
  {
    name: "write_file",
    description:
      "Write a UTF-8 analysis script or candidate implementation inside the owned workspace. Existing files require their exact expected SHA-256; does not execute the written file.",
    parameters: z.toJSONSchema(writeFileSchema),
  },
  {
    name: "list_files",
    description:
      "Page one directory in the owned workspace, including dot directories. Returns exact names, types and remaining coverage.",
    parameters: z.toJSONSchema(listFilesSchema),
  },
];
