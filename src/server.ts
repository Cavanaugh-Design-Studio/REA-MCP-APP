import {
  McpServer,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { configuredEngine, type Engine } from "./ai/Engine.js";
import { EvidenceStore } from "./evidence.js";
import { LocalTools } from "./localTools.js";
import { InvestigationRuns } from "./runs.js";
import { LEANREA_RESOURCE_URI, readBundledLeanrea } from "./skillResource.js";
import { configuredTelemetry, type Telemetry } from "./telemetry.js";
import { inspectStructuredView } from "./analysis/AnalysisViews.js";
import {
  taskInputSchema,
  readInputSchema,
  runIdSchema,
  workbenchInputSchema,
} from "./contracts.js";
import { FeatureProjectService } from "./retained/application/features/FeatureProjectService.js";
import { SqliteFeatureProjectStore } from "./retained/projects/SqliteFeatureProjectStore.js";
import { buildFeatureHandoff } from "./retained/application/features/FeatureHandoff.js";
import { writeFeatureHandoff } from "./retained/projects/FeatureHandoffWriter.js";
import { compareBrowserScenarioEvidence } from "./retained/application/features/BrowserScenarioComparison.js";
import { inspectAnalysisView } from "./retained/application/analysisView/AnalysisViewService.js";
import { inspectAnalysisViewInputSchema } from "./retained/domain/analysisView/analysisView.js";
import { projectAnalysisError } from "./retained/domain/analysisErrorProjection.js";
import {
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "./retained/domain/analysisErrorCore.js";
import type { Result } from "./retained/domain/result.js";
import type { AnalysisError } from "./retained/domain/analysisErrorBase.js";
import { WorkbenchBrowser } from "./retained/server/WorkbenchBrowser.js";
import {
  bufferedJsonParts,
  jsonParts,
} from "./retained/domain/jsonSerialization.js";

const uri = "ui://rea/workbench.html";
const object = z.record(z.string(), z.unknown());
// Inline source bodies stay opaque JSON in discovery; canonical Evidence is
// authenticated by the run boundary. Never embed the original schema catalog.
const startSchema = taskInputSchema.omit({ sources: true }).extend({
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("retained-evidence"),
          evidence_id: z.string(),
        }),
        z.strictObject({
          kind: z.literal("inline-evidence"),
          evidence: object,
        }),
      ]),
    )
    .default([]),
});
const projectId = z.string().uuid();
const namedSchemas = {
  get_evidence_bundle: z.strictObject({}),
  import_evidence_bundle: z.strictObject({ path: z.string() }),
  export_evidence_bundle: z.strictObject({
    path: z.string(),
    overwrite: z.boolean().default(false),
  }),
  list_unknowns: z.strictObject({}),
  inspect_analysis_view: z.strictObject({ source: object, view: object }),
  create_feature_project: object,
  read_feature_project: z.strictObject({
    project_id: projectId,
    revision: z.number().int().positive().optional(),
  }),
  list_feature_projects: z.strictObject({}),
  revise_feature_project: z.strictObject({
    project_id: projectId,
    expected_revision: z.number().int().positive(),
    definition: object,
  }),
  export_feature_handoff: z.strictObject({
    project_id: projectId,
    revision: z.number().int().positive().optional(),
    output_directory: z.string(),
  }),
  compare_browser_scenario_evidence: z.strictObject({
    left: object,
    right: object,
    normalization: object.optional(),
    origin_pair: object.optional(),
  }),
};
export const MODEL_TOOL_NAMES = [
  "rea_workbench",
  "start_investigation",
  "read_investigation",
  "cancel_investigation",
] as const;
export const APP_TOOL_NAMES = Object.keys(namedSchemas);

const failure = (cause: unknown): CallToolResult => {
  const diagnostic =
    cause && typeof cause === "object" && "_tag" in cause
      ? projectAnalysisError(cause as AnalysisError)
      : projectAnalysisError(
          new AnalysisProtocolError(
            cause instanceof Error && cause.name !== "ZodError"
              ? cause.message
              : "Invalid operation arguments",
          ),
        );
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: diagnostic }) }],
  };
};
export interface AppRuntime {
  server: McpServer;
  runs: InvestigationRuns;
  evidence: EvidenceStore;
  telemetry: Telemetry;
  close(): Promise<void>;
}
export const createApp = async (
  options: {
    environment?: Readonly<NodeJS.ProcessEnv>;
    engine?: Engine;
    skill?: string;
    telemetry?: Telemetry;
    searchFetch?: typeof fetch;
  } = {},
): Promise<AppRuntime> => {
  const environment = { ...(options.environment ?? process.env) };
  const responseLimit =
    environment.REA_MCP_MAX_RESPONSE_BYTES === undefined
      ? STDIO_DEFAULT_MAX_BUFFER_SIZE - 1024
      : z.coerce
          .number()
          .int()
          .positive()
          .safe()
          .parse(environment.REA_MCP_MAX_RESPONSE_BYTES);
  const response = (value: unknown, asEvidence = false): CallToolResult => {
    const oversized = () =>
      failure(
        new AnalysisResourceConstraintError(
          "mcp_response",
          "transport",
          "Complete data remains retained. Follow source pagination or export the Evidence/feature handoff; match larger response limits with the client's receive buffer.",
          { max_response_bytes: responseLimit },
        ),
      );
    let bytes = 0;
    const parts: string[] = [];
    for (const part of bufferedJsonParts(
      jsonParts(asEvidence ? value : { result: value }),
    )) {
      bytes += Buffer.byteLength(part);
      if (bytes > responseLimit) return oversized();
      parts.push(part);
    }
    const text = parts.join("");
    const structuredContent = JSON.parse(text) as Record<string, unknown>;
    const reply: CallToolResult = {
      content: [{ type: "text", text }],
      structuredContent,
    };
    bytes = 0;
    for (const part of bufferedJsonParts(jsonParts(reply))) {
      bytes += Buffer.byteLength(part);
      if (bytes > responseLimit) return oversized();
    }
    return reply;
  };
  const result = <T>(value: Result<T, AnalysisError>, asEvidence = false) =>
    value.ok ? response(value.value, asEvidence) : failure(value.error);
  const engine = options.engine ?? configuredEngine(environment);
  const bundledSkill = await readBundledLeanrea();
  const telemetry = options.telemetry ?? await configuredTelemetry(environment);
  const evidence = new EvidenceStore(telemetry);
  const tools = new LocalTools(environment, options.searchFetch);
  const store = new SqliteFeatureProjectStore(
    environment.REA_PROJECT_STORE ??
      join(homedir(), ".rea-mcp-app", "feature-projects.sqlite"),
  );
  const features = new FeatureProjectService(store);
  const skill = options.skill ?? bundledSkill;
  const runs = new InvestigationRuns(engine, evidence, tools, features, skill, telemetry);
  const server = new McpServer(
    { name: "rea-mcp-app", version: "0.1.0" },
    {
      instructions:
        "REA's internal agents carry out local reverse-engineering investigations. Submit the question and selected target with start_investigation, then read its status and Evidence-backed reports. The client need not execute the analysis steps. Open rea_workbench for interactive inspection. Models and analysis utilities are configured on the server.",
    },
  );
  const html = new URL("./ui/workbench.html", import.meta.url);
  server.registerResource(
    "leanrea-investigation-guide",
    LEANREA_RESOURCE_URI,
    {
      title: "Bundled leanrea investigation guide",
      description: "Read-only packaged guide used by REA's internal agents; no separate skill installation required. Retains upstream attribution and benchmark limits.",
      mimeType: "text/markdown",
    },
    async () => ({ contents: [{ uri: LEANREA_RESOURCE_URI, mimeType: "text/markdown", text: bundledSkill }] }),
  );
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
          text: await readFile(html, "utf8"),
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }),
  );
  const status = () => ({
    session: {
      open: false,
      path: null,
      execution: "internal-local-tools",
      platform: process.platform,
    },
    engine: runs.status(),
    telemetry: { enabled: telemetry.enabled },
  });
  const handlers = {
    get_evidence_bundle: async (
      _input: z.infer<typeof namedSchemas.get_evidence_bundle>,
    ) => response(evidence.bundle()),
    import_evidence_bundle: async (
      input: z.infer<typeof namedSchemas.import_evidence_bundle>,
    ) => {
      if (!isAbsolute(input.path))
        throw new Error("Bundle import path must be absolute");
      if (
        (await stat(input.path)).size >
        Number(environment.REA_IMPORT_MAX_BYTES ?? 67108864)
      )
        throw new Error("Bundle exceeds the configured import byte budget");
      return response(
        evidence.import(JSON.parse(await readFile(input.path, "utf8"))),
      );
    },
    export_evidence_bundle: async (
      input: z.infer<typeof namedSchemas.export_evidence_bundle>,
    ) => {
      if (!isAbsolute(input.path))
        throw new Error("Bundle export path must be absolute");
      if (input.overwrite) {
        try {
          await copyFile(input.path, `${input.path}.${Date.now()}.bak`);
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            cause.code !== "ENOENT"
          )
            throw cause;
        }
      }
      await writeFile(input.path, JSON.stringify(evidence.bundle(), null, 2), {
        flag: input.overwrite ? "w" : "wx",
      });
      return response({
        path: input.path,
        records: evidence.bundle().records.length,
      });
    },
    list_unknowns: async (_input: z.infer<typeof namedSchemas.list_unknowns>) =>
      response({
        items: evidence.bundle().unknowns,
        total: evidence.bundle().unknowns.length,
      }),
    inspect_analysis_view: async (
      input: z.infer<typeof namedSchemas.inspect_analysis_view>,
    ) => {
      if (
        input.source.kind === "retained-evidence" &&
        typeof input.source.evidence_id === "string"
      ) {
        const source = evidence.get(input.source.evidence_id);
        if (
          source &&
          (source.operation.startsWith("inspect_managed_") ||
            source.operation === "project_managed_application_graph")
        ) {
          const projected = inspectStructuredView(source, input.view);
          if (projected.ok) evidence.add(projected.value);
          return result(projected, true);
        }
      }
      const parsed = inspectAnalysisViewInputSchema.parse(input);
      if (parsed.source.kind === "retained-evidence") {
        const item = evidence.get(parsed.source.evidence_id);
        if (
          item?.operation.startsWith("run_local_") ||
          item?.operation.startsWith("read_local_") ||
          item?.operation === "list_local_files" ||
          item?.operation === "prepare_working_copy"
        )
          return response(item, true);
      }
      const view = inspectAnalysisView(parsed, (id) => evidence.get(id));
      if (view.ok) evidence.add(view.value);
      return result(view, true);
    },
    create_feature_project: async (
      input: z.infer<typeof namedSchemas.create_feature_project>,
    ) => {
      const created = features.create(input);
      return created.ok
        ? response({
            project_id: created.value.project_id,
            revision: created.value.revision,
          })
        : failure(created.error);
    },
    read_feature_project: async (
      input: z.infer<typeof namedSchemas.read_feature_project>,
    ) => result(features.inspect(input.project_id, input.revision)),
    list_feature_projects: async (
      _input: z.infer<typeof namedSchemas.list_feature_projects>,
    ) => {
      const listed = store.list();
      return listed.ok
        ? response({
            items: listed.value.map((item) => ({
              project_id: item.project_id,
              revision: item.revision,
              updated_at: item.updated_at,
              title: item.definition.title,
              goal: item.definition.goal,
            })),
          })
        : failure(listed.error);
    },
    revise_feature_project: async (
      input: z.infer<typeof namedSchemas.revise_feature_project>,
    ) => {
      const saved = features.revise(
        input.project_id,
        input.expected_revision,
        input.definition,
      );
      return saved.ok
        ? response({
            project_id: saved.value.project_id,
            revision: saved.value.revision,
          })
        : failure(saved.error);
    },
    export_feature_handoff: async (
      input: z.infer<typeof namedSchemas.export_feature_handoff>,
    ) => {
      const inspected = features.inspect(input.project_id, input.revision);
      return inspected.ok
        ? result(
            await writeFeatureHandoff(
              input.output_directory,
              buildFeatureHandoff(inspected.value),
            ),
          )
        : failure(inspected.error);
    },
    compare_browser_scenario_evidence: async (
      input: z.infer<typeof namedSchemas.compare_browser_scenario_evidence>,
    ) => {
      const compared = compareBrowserScenarioEvidence(input);
      if (compared.ok) {
        evidence.add(input.left);
        evidence.add(input.right);
        evidence.add(compared.value);
      }
      return result(compared, true);
    },
  };
  const readRun = (input: z.infer<typeof readInputSchema>) => {
    const read = runs.read(input.run_id);
    if (!read.ok) return failure(read.error);
    const sources = input.include_sources
      ? read.value.sources.slice(
          input.source_offset,
          input.source_offset + input.source_limit,
        )
      : [];
    return response({
      ...read.value,
      sources,
      total_sources: read.value.sources.length,
      source_offset: input.source_offset,
      next_source_offset:
        input.include_sources &&
        input.source_offset + sources.length < read.value.sources.length
          ? input.source_offset + sources.length
          : null,
    });
  };
  const browser = new WorkbenchBrowser(html, async (name, input) => {
    // The browser continuation owns only this connection's named App operations.
    switch (name) {
      case "rea_workbench":
        workbenchInputSchema.parse(input);
        return response(status());
      case "start_investigation":
        return result(runs.start(startSchema.parse(input)));
      case "read_investigation":
        return readRun(readInputSchema.parse(input));
      case "cancel_investigation":
        return result(runs.cancel(runIdSchema.parse(input).run_id));
      case "get_evidence_bundle":
        return handlers.get_evidence_bundle(
          namedSchemas.get_evidence_bundle.parse(input),
        );
      case "list_unknowns":
        return handlers.list_unknowns(namedSchemas.list_unknowns.parse(input));
      case "inspect_analysis_view":
        return handlers.inspect_analysis_view(
          namedSchemas.inspect_analysis_view.parse(input),
        );
      case "create_feature_project":
        return handlers.create_feature_project(
          namedSchemas.create_feature_project.parse(input),
        );
      case "read_feature_project":
        return handlers.read_feature_project(
          namedSchemas.read_feature_project.parse(input),
        );
      case "list_feature_projects":
        return handlers.list_feature_projects(
          namedSchemas.list_feature_projects.parse(input),
        );
      case "revise_feature_project":
        return handlers.revise_feature_project(
          namedSchemas.revise_feature_project.parse(input),
        );
      case "compare_browser_scenario_evidence":
        return handlers.compare_browser_scenario_evidence(
          namedSchemas.compare_browser_scenario_evidence.parse(input),
        );
      default:
        throw new Error(
          "This browser view does not expose filesystem export/import or host messaging",
        );
    }
  });
  const guard =
    <Input>(
      parse: (raw: unknown) => Input,
      run: (input: Input) => Promise<CallToolResult> | CallToolResult,
    ) =>
    async (raw: unknown) => {
      try {
        return await run(parse(raw));
      } catch (cause) {
        return failure(cause);
      }
    };
  const meta = { ui: { resourceUri: uri, visibility: ["model", "app"] } };
  server.registerTool(
    "rea_workbench",
    {
      description:
        "Open REA's investigation workbench and inspect internal-agent configuration and run status. Does not execute analysis or contact a model.",
      inputSchema: workbenchInputSchema,
      _meta: meta,
    },
    guard(
      (raw) => workbenchInputSchema.parse(raw),
      async (input) => {
        if (!input.open_browser) return response(status());
        const opened = await browser.open(input.handoff ?? {});
        return opened.ok
          ? response({ ...status(), browser_url: opened.value })
          : failure(opened.error);
      },
    ),
  );
  server.registerTool(
    "start_investigation",
    {
      description:
        "Assign a question and selected target to REA's internal agents. They prepare a working copy, execute installed local analysis tools using leanrea, and retain exact Evidence. The client does not perform analysis steps. Requires explicitly configured server-side models; supplied question and relevant Evidence are sent to that provider.",
      inputSchema: startSchema,
      _meta: meta,
    },
    guard(
      (raw) => startSchema.parse(raw),
      (input) => result(runs.start(input)),
    ),
  );
  server.registerTool(
    "read_investigation",
    {
      description:
        "Read status, complete inferred findings, local execution events and model usage for an assigned investigation. Sources are paginated and omitted by default. Missing coverage remains unknown.",
      inputSchema: readInputSchema,
      _meta: meta,
    },
    guard((raw) => readInputSchema.parse(raw), readRun),
  );
  server.registerTool(
    "cancel_investigation",
    {
      description:
        "Cancel a same-connection investigation and drain its owned local commands. Read until terminal. Retained Evidence survives cancellation; failed cleanup retains its owner.",
      inputSchema: runIdSchema,
    },
    guard(
      (raw) => runIdSchema.parse(raw),
      (input) => result(runs.cancel(input.run_id)),
    ),
  );
  const appMeta = { ui: { resourceUri: uri, visibility: ["app"] } };
  server.registerTool(
    "get_evidence_bundle",
    { inputSchema: namedSchemas.get_evidence_bundle, _meta: appMeta },
    guard(
      (raw) => namedSchemas.get_evidence_bundle.parse(raw),
      handlers.get_evidence_bundle,
    ),
  );
  server.registerTool(
    "import_evidence_bundle",
    { inputSchema: namedSchemas.import_evidence_bundle, _meta: appMeta },
    guard(
      (raw) => namedSchemas.import_evidence_bundle.parse(raw),
      handlers.import_evidence_bundle,
    ),
  );
  server.registerTool(
    "export_evidence_bundle",
    { inputSchema: namedSchemas.export_evidence_bundle, _meta: appMeta },
    guard(
      (raw) => namedSchemas.export_evidence_bundle.parse(raw),
      handlers.export_evidence_bundle,
    ),
  );
  server.registerTool(
    "list_unknowns",
    { inputSchema: namedSchemas.list_unknowns, _meta: appMeta },
    guard(
      (raw) => namedSchemas.list_unknowns.parse(raw),
      handlers.list_unknowns,
    ),
  );
  server.registerTool(
    "inspect_analysis_view",
    { inputSchema: namedSchemas.inspect_analysis_view, _meta: appMeta },
    guard(
      (raw) => namedSchemas.inspect_analysis_view.parse(raw),
      handlers.inspect_analysis_view,
    ),
  );
  server.registerTool(
    "create_feature_project",
    { inputSchema: namedSchemas.create_feature_project, _meta: appMeta },
    guard(
      (raw) => namedSchemas.create_feature_project.parse(raw),
      handlers.create_feature_project,
    ),
  );
  server.registerTool(
    "read_feature_project",
    { inputSchema: namedSchemas.read_feature_project, _meta: appMeta },
    guard(
      (raw) => namedSchemas.read_feature_project.parse(raw),
      handlers.read_feature_project,
    ),
  );
  server.registerTool(
    "list_feature_projects",
    { inputSchema: namedSchemas.list_feature_projects, _meta: appMeta },
    guard(
      (raw) => namedSchemas.list_feature_projects.parse(raw),
      handlers.list_feature_projects,
    ),
  );
  server.registerTool(
    "revise_feature_project",
    { inputSchema: namedSchemas.revise_feature_project, _meta: appMeta },
    guard(
      (raw) => namedSchemas.revise_feature_project.parse(raw),
      handlers.revise_feature_project,
    ),
  );
  server.registerTool(
    "export_feature_handoff",
    { inputSchema: namedSchemas.export_feature_handoff, _meta: appMeta },
    guard(
      (raw) => namedSchemas.export_feature_handoff.parse(raw),
      handlers.export_feature_handoff,
    ),
  );
  server.registerTool(
    "compare_browser_scenario_evidence",
    {
      inputSchema: namedSchemas.compare_browser_scenario_evidence,
      _meta: appMeta,
    },
    guard(
      (raw) => namedSchemas.compare_browser_scenario_evidence.parse(raw),
      handlers.compare_browser_scenario_evidence,
    ),
  );
  let closed = false;
  return {
    server,
    runs,
    evidence,
    telemetry,
    close: async () => {
      if (closed) return;
      await runs.close();
      await browser.close();
      store.close();
      await server.close();
      await telemetry.close();
      closed = true;
    },
  };
};
