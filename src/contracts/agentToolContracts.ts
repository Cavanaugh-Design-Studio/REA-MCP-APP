import { z } from "zod";
import {
  investigationInputSchema,
  investigationAcknowledgementSchema,
  investigationReadInputSchema,
  investigationPageSchema,
  runIdInputSchema,
} from "../domain/agentInvestigation.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

export const AGENT_TOOL_CONTRACTS = [
  {
    name: "rea_workbench",
    ...toolContractMetadata("rea_workbench"),
    kind: "session",
    description:
      "Open REA's interactive investigation workbench and report current session, cloud-engine configuration and worker runs. open_browser=true creates an expiring handoff to a loopback browser view of this same connection; optional handoff preserves the App's form and selection state. Does not start analysis or send data to a model.",
    inputSchema: z.strictObject({
      open_browser: z.boolean().optional(),
      handoff: jsonObjectSchema.optional(),
    }),
    outputSchema: z.strictObject({
      result: z.strictObject({
        browser_url: z.string().optional(),
        session: jsonValueSchema,
        engine: z.strictObject({
          enabled: z.boolean(),
          models: z
            .strictObject({
              analyst: z.string(),
              reviewer: z.string().nullable(),
            })
            .nullable(),
          runs: z.array(
            z.strictObject({
              run_id: z.string(),
              question: z.string(),
              state: z.string(),
              phase: z.string(),
            }),
          ),
        }),
      }),
    }),
    examples: [{ title: "Open the investigation workbench", input: {} }],
  },
  {
    name: "start_investigation",
    ...toolContractMetadata("start_investigation"),
    kind: "session",
    description:
      "Delegate a scoped question to the configured analyst/reviewer and optional planner, static-analyst and behavior-analyst specialists. Specialists share one request/deadline budget and return inferred reports to the analyst. Optional feature binds durable checkpoints to the exact current project revision and its assigned Evidence. Explicitly enabled cloud inference sends the selected question/Evidence to OpenRouter. Workers cannot switch targets or mutate executable bytes; limited runs never establish completeness.",
    inputSchema: investigationInputSchema,
    outputSchema: z.strictObject({
      result: investigationAcknowledgementSchema,
    }),
    examples: [
      {
        title: "Delegate interpretation of selected Evidence",
        input: {
          question: "Explain the observed behavior and remaining uncertainty",
          sources: [],
          review: false,
        },
      },
    ],
  },
  {
    name: "read_investigation",
    ...toolContractMetadata("read_investigation"),
    kind: "session",
    description:
      "Read one same-connection investigation's status, complete analyst/reviewer reports, events and model usage. Source bodies are omitted by default with total_sources reported. Select include_sources=true and follow next_source_offset for complete Evidence pages; default source_limit is one. Findings remain inferred; model agreement does not establish truth. Missing run IDs are explicit errors.",
    inputSchema: investigationReadInputSchema,
    outputSchema: z.strictObject({ result: investigationPageSchema }),
    examples: [
      {
        title: "Read an assigned run",
        input: { run_id: "caller-returned-run-id" },
      },
    ],
  },
  {
    name: "cancel_investigation",
    ...toolContractMetadata("cancel_investigation"),
    kind: "session",
    description:
      "Request cancellation of one same-connection investigation. Provider ownership is retained until operations settle. Read the run until it becomes terminal; previously collected Evidence remains available.",
    inputSchema: runIdInputSchema,
    outputSchema: z.strictObject({
      result: investigationAcknowledgementSchema,
    }),
    examples: [
      {
        title: "Cancel an assigned run",
        input: { run_id: "caller-returned-run-id" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
