import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { createFeatureProjectService } from "../composition/featureProjects.js";
import { parseCliJsonInput } from "../cliJsonInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { logCliCommand, isCliOperationFailure } from "../cliLogging.js";
import { toolContract } from "../contracts/toolContracts.js";
import { buildFeatureHandoff } from "../application/features/FeatureHandoff.js";
import { writeFeatureHandoff } from "../projects/FeatureHandoffWriter.js";
import { compareBrowserScenarioEvidence } from "../application/features/BrowserScenarioComparison.js";
import { ok } from "../domain/result.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";

const commands = {
  create_feature_project: CLI_COMMANDS.createFeatureProject,
  read_feature_project: CLI_COMMANDS.readFeatureProject,
  list_feature_projects: CLI_COMMANDS.listFeatureProjects,
  revise_feature_project: CLI_COMMANDS.reviseFeatureProject,
  export_feature_handoff: CLI_COMMANDS.exportFeatureHandoff,
  compare_browser_scenario_evidence:
    CLI_COMMANDS.compareBrowserScenarioEvidence,
} as const;

/** One-shot durable feature commands call the same application services as MCP. */
export const registerFeatureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  for (const operation of [
    "create_feature_project",
    "read_feature_project",
    "list_feature_projects",
    "revise_feature_project",
    "export_feature_handoff",
    "compare_browser_scenario_evidence",
  ] as const) {
    const name = commands[operation];
    cli.command(name, {
      description: toolContract(operation).description,
      args: z.object({
        inputJson: z.string().describe("Tool input JSON or JSON file path"),
      }),
      run: ({ args }) =>
        logCliCommand(
          logger,
          name,
          async () => {
            const raw = await parseCliJsonInput(args.inputJson, name);
            if (!raw.ok) return raw.error;
            const service = createFeatureProjectService(environment);
            try {
              const result = await (async () => {
                switch (operation) {
                  case "create_feature_project":
                    return service.create(
                      toolContract(operation).inputSchema.parse(raw.value),
                    );
                  case "read_feature_project": {
                    const input = toolContract(operation).inputSchema.parse(
                      raw.value,
                    );
                    return service.inspect(input.project_id, input.revision);
                  }
                  case "list_feature_projects": {
                    toolContract(operation).inputSchema.parse(raw.value);
                    const listed = service.store.list();
                    return listed.ok
                      ? ok({
                          items: listed.value.map((value) => ({
                            project_id: value.project_id,
                            revision: value.revision,
                            title: value.definition.title,
                            goal: value.definition.goal,
                            updated_at: value.updated_at,
                          })),
                        })
                      : listed;
                  }
                  case "revise_feature_project": {
                    const input = toolContract(operation).inputSchema.parse(
                      raw.value,
                    );
                    return service.revise(
                      input.project_id,
                      input.expected_revision,
                      input.definition,
                    );
                  }
                  case "export_feature_handoff": {
                    const input = toolContract(operation).inputSchema.parse(
                      raw.value,
                    );
                    const inspected = service.inspect(
                      input.project_id,
                      input.revision,
                    );
                    return inspected.ok
                      ? writeFeatureHandoff(
                          input.output_directory,
                          buildFeatureHandoff(inspected.value),
                        )
                      : inspected;
                  }
                  case "compare_browser_scenario_evidence":
                    return compareBrowserScenarioEvidence(raw.value);
                }
              })();
              return result.ok
                ? { result: result.value }
                : { error: projectAnalysisError(result.error) };
            } finally {
              service.store.close();
            }
          },
          isCliOperationFailure,
        ),
    });
  }
};
