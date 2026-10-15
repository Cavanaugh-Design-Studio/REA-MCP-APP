import { OpenRouterEngine } from "../ai/OpenRouterEngine.js";
import type { AgentEngine } from "../application/agents/AgentEngine.js";
import { OpenRouterSpendLedger } from "../ai/OpenRouterSpendLedger.js";
import { z } from "zod";

/** Cloud inference is explicitly enabled, with caller-configured model IDs and server-only credentials. */
export const createAgentEngine = (
  environment: Readonly<NodeJS.ProcessEnv>,
): AgentEngine | undefined => {
  if (environment.REA_AI_ENABLED !== "true") return undefined;
  const key = environment.OPENROUTER_API_KEY;
  const analyst = environment.REA_AI_ANALYST_MODEL;
  if (!key || !analyst) return undefined;
  return new OpenRouterEngine(
    { analyst, reviewer: environment.REA_AI_REVIEWER_MODEL || null },
    key,
    fetch,
    environment.REA_AI_SPEND_LIMIT_USD || environment.REA_AI_SPEND_LEDGER
      ? new OpenRouterSpendLedger(
          environment.REA_AI_SPEND_LEDGER ?? "",
          Number(environment.REA_AI_SPEND_LIMIT_USD),
        )
      : undefined,
    {
      analyst: z
        .enum(["json-schema", "json-object"])
        .default("json-schema")
        .parse(environment.REA_AI_ANALYST_REPORT_FORMAT),
      reviewer: z
        .enum(["json-schema", "json-object"])
        .default("json-schema")
        .parse(environment.REA_AI_REVIEWER_REPORT_FORMAT),
    },
  );
};
