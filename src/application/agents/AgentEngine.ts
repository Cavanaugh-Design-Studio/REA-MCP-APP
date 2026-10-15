import type { AgentDecision } from "../../domain/agentInvestigation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Model protocol is owned by the engine adapter, never by the investigation workflow. */
export interface AgentEngine {
  readonly models: {
    readonly analyst: string;
    readonly reviewer: string | null;
  };
  generate(request: {
    readonly role: "analyst" | "reviewer";
    readonly context: string;
    readonly maxOutputTokens: number;
    readonly maxResponseBytes: number;
    readonly signal: AbortSignal;
    readonly allowFunctionAnalysis: boolean;
  }): Promise<
    Result<
      {
        readonly decision: AgentDecision;
        readonly requestedModel: string;
        readonly returnedModel: string | null;
        readonly provider: string | null;
        readonly inputTokens: number | null;
        readonly outputTokens: number | null;
        readonly costUsd: number | null;
      },
      AnalysisError
    >
  >;
}
