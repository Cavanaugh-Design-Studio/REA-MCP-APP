import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { isCliOperationFailure, logCliCommand } from "../cliLogging.js";
import { createAgentEngine } from "../composition/agentEngine.js";
import { InvestigationCoordinator } from "../application/agents/InvestigationCoordinator.js";
import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { err, ok } from "../domain/result.js";
import { createFeatureProjectService } from "../composition/featureProjects.js";
import { FeatureInvestigationBinding } from "../application/features/FeatureInvestigationBinding.js";
import { investigationInputSchema } from "../domain/agentInvestigation.js";

/** One-shot worker team over portable Evidence; session lifecycle stays with the MCP adapter. */
export const registerAgentCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  cli.command(CLI_COMMANDS.investigate, {
    description:
      "Delegate a question over portable inline Evidence to the configured analyst and reviewer",
    args: z.object({
      inputJson: z.string().describe("Investigation JSON or JSON file path"),
    }),
    run: ({ args }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.investigate,
        async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            CLI_COMMANDS.investigate,
          );
          if (!input.ok) return input.error;
          const assignment = investigationInputSchema.safeParse(input.value);
          if (!assignment.success)
            return {
              error: projectAnalysisError(
                new AnalysisInputError("investigate", {
                  cause: assignment.error,
                }),
              ),
            };
          const features = createFeatureProjectService(environment);
          const jobs = new FeatureInvestigationBinding(features);
          const coordinator = new InvestigationCoordinator(
            createAgentEngine(environment),
            {
              resolve: (id) => {
                if (!assignment.data.feature) return undefined;
                const project = features.store.read(
                  assignment.data.feature.project_id,
                );
                return project.ok
                  ? project.value.definition.evidence_bundle.records.find(
                      (item) => item.evidence_id === id,
                    )
                  : undefined;
              },
              withScope: async (_signal, sources, run) =>
                ok(
                  await run(async (name, arguments_) =>
                    name === "inspect_analysis_view"
                      ? inspectAnalysisView(arguments_, (id) =>
                          sources.find((source) => source.evidence_id === id),
                        )
                      : err(
                          new AnalysisCapabilityUnavailableError(
                            "reasoning-engine",
                            name,
                            "CLI investigations accept portable Evidence only; use MCP with an active target for function analysis",
                          ),
                        ),
                  ),
                ),
            },
            (value) => jobs.checkpoint(value),
            (runId) => jobs.settled(runId),
          );
          try {
            const prepared = jobs.prepare(assignment.data);
            if (!prepared.ok)
              return { error: projectAnalysisError(prepared.error) };
            const started = coordinator.start(assignment.data);
            if (!started.ok)
              return { error: projectAnalysisError(started.error) };
            const attached = jobs.attach(started.value.run_id, assignment.data);
            if (!attached.ok) {
              coordinator.cancel(started.value.run_id);
              return { error: projectAnalysisError(attached.error) };
            }
            while (true) {
              const result = coordinator.read(started.value.run_id);
              if (!result.ok)
                return { error: projectAnalysisError(result.error) };
              if (result.value.state !== "running") return result.value;
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
          } finally {
            await coordinator.close();
            features.store.close();
          }
        },
        (value) =>
          isCliOperationFailure(value) ||
          (typeof value === "object" &&
            value !== null &&
            "state" in value &&
            value.state !== "completed"),
      ),
  });
};
