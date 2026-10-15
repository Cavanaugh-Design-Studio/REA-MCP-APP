import { readFile } from "node:fs/promises";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { createAgentEngine } from "../composition/agentEngine.js";
import type { AgentEngine } from "../application/agents/AgentEngine.js";
import { InvestigationCoordinator } from "../application/agents/InvestigationCoordinator.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { executeFunctionAnalysisEvidence } from "../application/FunctionAnalysisEvidence.js";
import { inspectAnalysisView } from "../application/analysisView/AnalysisViewService.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { toolContract } from "../contracts/toolContracts.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { WorkbenchBrowser } from "./WorkbenchBrowser.js";
import { createFeatureProjectService } from "../composition/featureProjects.js";
import { registerFeatureTools } from "./registerFeatureTools.js";
import { FeatureInvestigationBinding } from "../application/features/FeatureInvestigationBinding.js";

const workbenchHtml = () =>
  new URL(
    import.meta.url.endsWith(".ts")
      ? "../../dist/ui/workbench.html"
      : "../ui/workbench.html",
    import.meta.url,
  );

/** Package-relative HTML registration applies to all UI-enhanced tools, including fixed-target servers. */
export const registerWorkbenchResource = (server: EvidenceMcpServer): void => {
  const uri = "ui://rea/workbench.html";
  registerAppResource(
    server,
    uri,
    uri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    },
    async () => ({
      contents: [
        {
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
          text: await readFile(workbenchHtml(), "utf8"),
        },
      ],
    }),
  );
};

/** Delegate reasoning through existing admitted application workflows without granting lifecycle authority. */
export const registerAgentTools = (
  server: EvidenceMcpServer,
  session: BinarySessionPort,
  environment: Readonly<NodeJS.ProcessEnv>,
  engine?: AgentEngine,
): { close(): Promise<void> } => {
  const features = createFeatureProjectService(environment);
  const featureHandlers = registerFeatureTools(server, session, features);
  const featureJobs = new FeatureInvestigationBinding(features);
  const coordinator = new InvestigationCoordinator(
    engine ?? createAgentEngine(environment),
    {
      resolve: (id) => session.evidenceById(id),
      withScope: (signal, sources, run) =>
        session.withAdmittedAnalysis(
          "start_investigation",
          signal,
          (analysis) =>
            run(async (name, args) => {
              const observed =
                name === "inspect_analysis_view"
                  ? inspectAnalysisView(args, (id) =>
                      sources.find((source) => source.evidence_id === id),
                    )
                  : session.activeTarget() === undefined
                    ? err(
                        new AnalysisCapabilityUnavailableError(
                          "reasoning-engine",
                          name,
                          "Function analysis requires an active target",
                        ),
                      )
                    : await executeFunctionAnalysisEvidence(
                        analysis,
                        args,
                        session.activeTarget(),
                        { signal },
                      );
              if (!observed.ok || signal.aborted)
                return signal.aborted
                  ? err(
                      new AnalysisCapabilityUnavailableError(
                        "reasoning-engine",
                        name,
                        "Investigation was cancelled before publication",
                      ),
                    )
                  : observed;
              const recorded = session.recordEvidence(observed.value);
              return recorded.ok ? observed : recorded;
            }),
        ),
    },
    (value) => featureJobs.checkpoint(value),
    (runId) => featureJobs.settled(runId),
  );
  const workbench = toolContract("rea_workbench");
  const start = toolContract("start_investigation");
  const read = toolContract("read_investigation");
  const cancel = toolContract("cancel_investigation");
  const status = () =>
    server.delivery.toCallToolResult(
      ok(
        jsonValueSchema.parse({
          session: session.status(),
          engine: coordinator.status(),
        }),
      ),
      workbench,
    );
  const startRun = (input: typeof start.inputSchema._output) => {
    const prepared = featureJobs.prepare(input);
    if (!prepared.ok) return server.delivery.toErrorToolResult(prepared.error);
    const started = coordinator.start(input);
    if (!started.ok) return server.delivery.toErrorToolResult(started.error);
    const attached = featureJobs.attach(started.value.run_id, input);
    if (!attached.ok) {
      coordinator.cancel(started.value.run_id);
      return server.delivery.toErrorToolResult(attached.error);
    }
    return server.delivery.toCallToolResult(started, start);
  };
  const readRun = (input: typeof read.inputSchema._output) => {
    const result = coordinator.read(input.run_id);
    if (!result.ok) return server.delivery.toErrorToolResult(result.error);
    const value = result.value;
    const sources = input.include_sources
      ? value.sources.slice(
          input.source_offset,
          input.source_offset + input.source_limit,
        )
      : [];
    return server.delivery.toCallToolResult(
      ok({
        ...value,
        sources,
        total_sources: value.sources.length,
        source_offset: input.source_offset,
        next_source_offset:
          input.include_sources &&
          input.source_offset + sources.length < value.sources.length
            ? input.source_offset + sources.length
            : null,
      }),
      read,
    );
  };
  const cancelRun = (input: typeof cancel.inputSchema._output) => {
    const result = coordinator.cancel(input.run_id);
    return server.delivery.toCallToolResult(
      result.ok
        ? ok({
            run_id: result.value.run_id,
            state: result.value.state,
            phase: result.value.phase,
          })
        : result,
      cancel,
    );
  };
  const browser = new WorkbenchBrowser(workbenchHtml(), (name, args) => {
    switch (name) {
      case "create_feature_project":
        return featureHandlers.create_feature_project(
          toolContract("create_feature_project").inputSchema.parse(args),
        );
      case "read_feature_project":
        return featureHandlers.read_feature_project(
          toolContract("read_feature_project").inputSchema.parse(args),
        );
      case "list_feature_projects":
        return featureHandlers.list_feature_projects(
          toolContract("list_feature_projects").inputSchema.parse(args),
        );
      case "revise_feature_project":
        return featureHandlers.revise_feature_project(
          toolContract("revise_feature_project").inputSchema.parse(args),
        );
      case "compare_browser_scenario_evidence":
        return featureHandlers.compare_browser_scenario_evidence(
          toolContract("compare_browser_scenario_evidence").inputSchema.parse(
            args,
          ),
        );
      case "rea_workbench":
        workbench.inputSchema.parse(args);
        return status();
      case "start_investigation":
        return startRun(start.inputSchema.parse(args));
      case "read_investigation":
        return readRun(read.inputSchema.parse(args));
      case "cancel_investigation":
        return cancelRun(cancel.inputSchema.parse(args));
      case "get_evidence_bundle": {
        const contract = toolContract("get_evidence_bundle");
        contract.inputSchema.parse(args);
        return server.delivery.toCallToolResult(
          ok(
            session.evidenceBundleForSerialization?.() ??
              session.exportEvidenceBundle(),
          ),
          contract,
        );
      }
      case "list_unknowns": {
        const contract = toolContract("list_unknowns");
        const input = contract.inputSchema.parse(args);
        const items = session.listUnknowns({
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.severity === undefined ? {} : { severity: input.severity }),
          ...(input.domain === undefined ? {} : { domain: input.domain }),
        });
        return server.delivery.toCallToolResult(
          ok({ items, total: items.length }),
          contract,
        );
      }
      case "inspect_analysis_view": {
        const contract = toolContract("inspect_analysis_view");
        const result = inspectAnalysisView(
          contract.inputSchema.parse(args),
          (id) => session.evidenceById(id),
        );
        if (!result.ok) return server.delivery.toErrorToolResult(result.error);
        const recorded = session.recordEvidence(result.value);
        return server.delivery.toEvidenceToolResult(
          result.value,
          contract,
          recorded,
        );
      }
      default:
        throw new Error(
          "This browser view does not expose target lifecycle, filesystem or host messaging tools",
        );
    }
  });
  server.registerTool(
    workbench.name,
    toolRegistrationOptions(workbench),
    async (input) => {
      if (!input.open_browser) return status();
      const opened = await browser.open(input.handoff ?? {});
      if (!opened.ok) return server.delivery.toErrorToolResult(opened.error);
      const browser_url = opened.value;
      return server.delivery.toCallToolResult(
        ok(
          jsonValueSchema.parse({
            session: session.status(),
            engine: coordinator.status(),
            browser_url,
          }),
        ),
        workbench,
      );
    },
  );
  server.registerTool(start.name, toolRegistrationOptions(start), startRun);
  server.registerTool(read.name, toolRegistrationOptions(read), readRun);
  server.registerTool(cancel.name, toolRegistrationOptions(cancel), cancelRun);
  return {
    close: async () => {
      const results = await Promise.allSettled([
        browser.close(),
        coordinator.close(),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "Workbench cleanup failed");
      features.store.close();
    },
  };
};
