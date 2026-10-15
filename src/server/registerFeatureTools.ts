import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { FeatureProjectService } from "../application/features/FeatureProjectService.js";
import { buildFeatureHandoff } from "../application/features/FeatureHandoff.js";
import { writeFeatureHandoff } from "../projects/FeatureHandoffWriter.js";
import { compareBrowserScenarioEvidence } from "../application/features/BrowserScenarioComparison.js";
import { toolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { ok } from "../domain/result.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";

const jsonResult = <T>(result: Result<T, AnalysisError>) =>
  result.ok ? ok(jsonValueSchema.parse(result.value)) : result;

/** Named handler/schema bindings are shared with the authenticated browser view. */
export const registerFeatureTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  features: FeatureProjectService,
) => {
  const create = toolContract("create_feature_project");
  const read = toolContract("read_feature_project");
  const list = toolContract("list_feature_projects");
  const revise = toolContract("revise_feature_project");
  const exportContract = toolContract("export_feature_handoff");
  const compare = toolContract("compare_browser_scenario_evidence");
  const handlers = {
    create_feature_project: (input: typeof create.inputSchema._output) =>
      server.delivery.toCallToolResult(
        jsonResult(features.create(input)),
        create,
      ),
    read_feature_project: (input: typeof read.inputSchema._output) =>
      server.delivery.toCallToolResult(
        jsonResult(features.inspect(input.project_id, input.revision)),
        read,
      ),
    list_feature_projects: (_input: typeof list.inputSchema._output) => {
      const result = features.store.list();
      return server.delivery.toCallToolResult(
        result.ok
          ? ok({
              items: result.value.map((value) => ({
                project_id: value.project_id,
                revision: value.revision,
                updated_at: value.updated_at,
                title: value.definition.title,
                goal: value.definition.goal,
              })),
            })
          : result,
        list,
      );
    },
    revise_feature_project: (input: typeof revise.inputSchema._output) =>
      server.delivery.toCallToolResult(
        jsonResult(
          features.revise(
            input.project_id,
            input.expected_revision,
            input.definition,
          ),
        ),
        revise,
      ),
    export_feature_handoff: async (
      input: typeof exportContract.inputSchema._output,
    ) => {
      const result = features.inspect(input.project_id, input.revision);
      return server.delivery.toCallToolResult(
        result.ok
          ? await writeFeatureHandoff(
              input.output_directory,
              buildFeatureHandoff(result.value),
            )
          : result,
        exportContract,
      );
    },
    compare_browser_scenario_evidence: (
      input: typeof compare.inputSchema._output,
    ) => {
      const result = compareBrowserScenarioEvidence(input);
      if (!result.ok) return server.delivery.toErrorToolResult(result.error);
      const recordedLeft = session.recordEvidence(input.left);
      if (!recordedLeft.ok)
        return server.delivery.toErrorToolResult(recordedLeft.error);
      const recordedRight = session.recordEvidence(input.right);
      if (!recordedRight.ok)
        return server.delivery.toErrorToolResult(recordedRight.error);
      return server.delivery.toEvidenceToolResult(
        result.value,
        compare,
        session.recordEvidence(result.value),
      );
    },
  };
  server.registerTool(
    create.name,
    toolRegistrationOptions(create),
    handlers.create_feature_project,
  );
  server.registerTool(
    read.name,
    toolRegistrationOptions(read),
    handlers.read_feature_project,
  );
  server.registerTool(
    list.name,
    toolRegistrationOptions(list),
    handlers.list_feature_projects,
  );
  server.registerTool(
    revise.name,
    toolRegistrationOptions(revise),
    handlers.revise_feature_project,
  );
  server.registerTool(
    exportContract.name,
    toolRegistrationOptions(exportContract),
    handlers.export_feature_handoff,
  );
  server.registerTool(
    compare.name,
    toolRegistrationOptions(compare),
    handlers.compare_browser_scenario_evidence,
  );
  return handlers;
};
