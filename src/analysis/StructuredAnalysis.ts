import pino from "pino";
import { createEvidence, type Evidence } from "../retained/domain/evidence.js";
import { jsonValueSchema } from "../retained/domain/jsonValue.js";
import { ok, err, type Result } from "../retained/domain/result.js";
import type { AnalysisError } from "../retained/domain/analysisErrorBase.js";
import {
  AnalysisProtocolError,
  AnalysisCapabilityUnavailableError,
} from "../retained/domain/analysisErrorCore.js";
import { analyzeJavaScriptApplication } from "../retained/application/javascript/JavaScriptApplicationService.js";
import { ArtifactResourceScope } from "../retained/artifacts/ArtifactResourceScope.js";
import { ManagedStaticProvider } from "../retained/dotnet/ManagedStaticProvider.js";
import { MANAGED_STATIC_PROVIDER } from "../retained/application/InvestigationProviders.js";
import { projectManagedApplicationGraphEvidence } from "../retained/application/managed/ManagedApplicationGraphService.js";
import { parseBinaryTarget } from "../retained/application/BinaryTargetResolver.js";
import { GhidraProvider } from "../retained/ghidra/GhidraProvider.js";
import { systemGhidraInstallationHost } from "../retained/ghidra/GhidraInstallation.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../retained/process/OwnedCommand.js";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { closeGhidraLaunchSupport } from "./GhidraLaunchSupport.js";
import { inspectStructuredView } from "./AnalysisViews.js";
import { analysisExecutionContext } from "./environment.js";
import { projectAnalysisError } from "../retained/domain/analysisErrorProjection.js";
import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AppConfig } from "../retained/config/types.js";
import type { AnalysisClient } from "../retained/application/AnalysisProvider.js";
import { browserScenarioSchema } from "../retained/domain/browserScenario.js";
import { createBrowserScenarioProvider } from "../retained/composition/browserScenario.js";
import { captureBrowserScenario } from "../retained/application/BrowserScenarioCaptureService.js";
import {
  javascriptInput,
  managedInput,
  nativeInput,
  graphInput,
  browserInput,
  viewInput,
} from "./contracts.js";

export type ScopedPath = (path: string, writing?: boolean) => Promise<string>;
type Cleanup = { close(): Promise<unknown> };
export class StructuredAnalysis {
  readonly #failedOwners = new Set<Cleanup>();
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv>) {}
  async close(): Promise<void> {
    await closeGhidraLaunchSupport();
    for (const owner of this.#failedOwners) {
      const result = await owner.close();
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      )
        throw new Error("Analysis cleanup remains incomplete");
      this.#failedOwners.delete(owner);
    }
  }
  async #release(owner: Cleanup): Promise<void> {
    try {
      const result = await owner.close();
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      )
        throw new Error("Analysis cleanup remains incomplete");
    } catch (cause) {
      this.#failedOwners.add(owner);
      throw cause;
    }
  }
  async execute(
    name: string,
    raw: unknown,
    selectedTarget: string | null,
    path: ScopedPath,
    runId: string,
    signal: AbortSignal,
    sources: readonly Evidence[],
    root: string,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (this.#failedOwners.size)
      return err(
        new AnalysisProtocolError(
          "A retained analysis owner has unresolved cleanup; close/retry cleanup before further analysis",
        ),
      );
    const targetPath = async (supplied?: string) => {
      const target = supplied ?? selectedTarget;
      if (!target) throw new Error("A local working target is required");
      return path(target);
    };
    if (name === "analyze_javascript_application") {
      const input = javascriptInput.parse(raw);
      const selected = await targetPath(input.path);
      if ([".dmg", ".pkg"].includes(extname(selected).toLowerCase()))
        return err(
          new AnalysisCapabilityUnavailableError(
            "inert-artifact",
            name,
            "Provide an extracted self-contained working copy for DMG/PKG analysis; this semantic lane does not mount or execute package utilities",
          ),
        );
      const scope = new ArtifactResourceScope();
      try {
        return await analyzeJavaScriptApplication(
          { input_path: selected },
          scope,
          { signal },
        );
      } finally {
        await this.#release(scope);
      }
    }
    if (name === "inspect_managed_code") {
      const input = managedInput.parse(raw),
        selected = await targetPath(input.path);
      const target = await parseBinaryTarget(selected, { signal });
      if (!target.ok)
        return err(new AnalysisProtocolError(target.error.message));
      if (target.value.format !== "pe")
        throw new Error("Managed inspection requires an exact PE/CLR artifact");
      const operation =
        input.facet === "identity"
          ? "inspect_managed_artifact"
          : input.facet === "members"
            ? "inspect_managed_members"
            : "inspect_managed_native_boundaries";
      const client = new ManagedStaticProvider().createClient(target.value);
      try {
        const executed = await client.execute(operation, {}, { signal });
        if (!executed.ok) return executed;
        const value = executed.value;
        return ok(
          createEvidence(target.value, MANAGED_STATIC_PROVIDER, {
            operation,
            parameters: {},
            result: value.result,
            rawResult: value.rawResult,
            confidence: "observed",
            authority: "shipped-artifact",
            locations: value.locations,
            limitations: value.limitations,
          }),
        );
      } finally {
        await this.#release(client);
      }
    }
    if (name === "project_analysis_graph") {
      const input = graphInput.parse(raw);
      const records = input.evidence_ids.map((id) => {
        const record = sources.find((item) => item.evidence_id === id);
        if (!record)
          throw new Error("Graph sources must belong to this investigation");
        return record;
      });
      const byOperation = (operation: string) =>
        records.find((item) => item.operation === operation);
      if (
        new Set(records.map((item) => item.operation)).size !==
          records.length ||
        records.some(
          (item) =>
            ![
              "inspect_managed_artifact",
              "inspect_managed_members",
              "inspect_managed_native_boundaries",
            ].includes(item.operation),
        )
      )
        throw new Error(
          "Select distinct managed identity, members and/or native-boundary observations",
        );
      return projectManagedApplicationGraphEvidence(
        Object.fromEntries(
          [
            ["managed_artifact", byOperation("inspect_managed_artifact")],
            ["managed_members", byOperation("inspect_managed_members")],
            [
              "managed_native_boundaries",
              byOperation("inspect_managed_native_boundaries"),
            ],
          ].filter(([, value]) => value !== undefined),
        ),
      );
    }
    if (name === "inspect_native_code") {
      const input = nativeInput.parse(raw);
      const parsed = await parseBinaryTarget(await targetPath(input.path), {
        signal,
      });
      if (!parsed.ok)
        return err(new AnalysisProtocolError(parsed.error.message));
      const javaHome =
        this.environment.REA_GHIDRA_JAVA_HOME ?? this.environment.JAVA_HOME;
      if (!this.environment.REA_GHIDRA_INSTALL_DIR || !javaHome)
        return err(
          new AnalysisCapabilityUnavailableError(
            "ghidra",
            name,
            "Configure server-side REA_GHIDRA_INSTALL_DIR and REA_GHIDRA_JAVA_HOME for caller-installed Ghidra/JDK",
          ),
        );
      if (
        !isAbsolute(javaHome) ||
        !isAbsolute(this.environment.REA_GHIDRA_INSTALL_DIR)
      )
        throw new Error(
          "Ghidra and JDK directories must be absolute server-selected paths",
        );
      const config: AppConfig = {
        analysisProvider: "ghidra",
        ghidraInstallDir: this.environment.REA_GHIDRA_INSTALL_DIR,
        ghidraJavaHome: javaHome,
        ghidraStartupTimeoutMs: 180000,
        ilspyCmdPath: undefined,
        hopperLauncherPath: "",
        hopperTargetPath: undefined,
        hopperTargetKind: "executable",
        hopperLoaderArgs: [],
        logLevel: "silent",
        referenceSourcePolicy: { secretPatterns: [] },
      };
      let javaOutput;
      try {
        javaOutput = await runOwnedCommand(
          {
            command: join(
              javaHome,
              "bin",
              process.platform === "win32" ? "java.exe" : "java",
            ),
            arguments: [
              "-XX:-UsePerfData",
              "-XshowSettings:properties",
              "-version",
            ],
            runId: `java-probe-${randomUUID()}`,
            cwd: root,
            hostEnvironment: this.environment,
          },
          { timeoutMs: 5000, diagnosticBytes: 65536 },
          { signal },
        );
      } catch (cause) {
        if (cause instanceof OwnedCommandFailure && cause.cleanupOwner) {
          const owner = cause.cleanupOwner;
          this.#failedOwners.add({
            close: async () => {
              const result = await owner.stop();
              if (result.status === "incomplete")
                throw new Error(result.reason);
            },
          });
        }
        throw cause;
      }
      const javaText = javaOutput.stdout.text + "\n" + javaOutput.stderr.text;
      const property = (key: string) =>
        javaText
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find((line) => line.startsWith(`${key} = `))
          ?.slice(key.length + 3)
          .trim();
      const version = property("java.version"),
        home = property("java.home");
      const java =
        version && home
          ? {
              version,
              major: Number(
                version.split(".")[0] === "1"
                  ? version.split(".")[1]
                  : version.split(".")[0],
              ),
              home,
              bits: Number(property("sun.arch.data.model")),
              runtime: existsSync(
                join(
                  home,
                  "bin",
                  process.platform === "win32" ? "javac.exe" : "javac",
                ),
              )
                ? ("jdk" as const)
                : ("jre" as const),
            }
          : undefined;
      const provider = new GhidraProvider(
        config,
        pino({ level: "silent" }),
        this.environment,
        { ...systemGhidraInstallationHost(), probeJava: () => java },
      );
      const availability = provider.inspectAvailability();
      if (availability.status !== "available")
        return err(
          new AnalysisCapabilityUnavailableError(
            "ghidra",
            name,
            availability.reason ??
              "Configure a caller-installed Ghidra directory",
          ),
        );
      const support = provider.inspectTargetSupport(parsed.value);
      if (support.status !== "supported")
        throw new Error(
          support.reason ?? "Ghidra does not support this target",
        );
      const resolved = await provider.resolveAnalysisProfile(parsed.value, {
        signal,
      });
      if (!resolved.ok) return resolved;
      const client: AnalysisClient = provider.createClient(
        parsed.value,
        resolved.value.profile ?? undefined,
        { runId },
      );
      try {
        const operation = input.address
          ? "analyze_function"
          : "list_procedures";
        const executed = await client.execute(
          operation,
          input.address ? { address: input.address } : {},
          { signal },
        );
        if (!executed.ok) return executed;
        const value = executed.value;
        const items = Array.isArray(value.result) ? value.result : [];
        return ok(
          createEvidence(parsed.value, value.provider, {
            operation: input.address ? operation : "inspect_native_functions",
            ...(value.analysisProfile
              ? { analysisProfile: value.analysisProfile }
              : {}),
            parameters: input.address
              ? { address: input.address }
              : { offset: input.offset, limit: input.limit },
            result: input.address
              ? value.result
              : {
                  items: items.slice(input.offset, input.offset + input.limit),
                  total: items.length,
                  next_offset:
                    input.offset + input.limit < items.length
                      ? input.offset + input.limit
                      : null,
                },
            rawResult: value.rawResult,
            confidence: "derived",
            authority: "shipped-artifact",
            limitations: value.limitations,
            locations: value.locations,
          }),
        );
      } finally {
        await this.#release(client);
      }
    }
    if (name === "capture_browser_scenario") {
      const input = browserInput.parse(raw),
        scenario = browserScenarioSchema.parse(input.scenario);
      if (scenario.browser.mode !== "launch")
        throw new Error(
          "Internal capture launches an owned browser; imported external captures remain inspectable",
        );
      if (scenario.secrets.length)
        throw new Error(
          "Internal captures do not receive server credentials; use explicit public fixture inputs",
        );
      const provider = createBrowserScenarioProvider({
        ...this.environment,
        REA_BROWSER_PROFILE_ROOT: root,
      });
      const processes: Array<Record<string, unknown>> = [],
        receiptPath = join(root, `browser-processes-${randomUUID()}.json`);
      try {
        const captured = await analysisExecutionContext.run(
          { environment: this.environment, parent: root, processes },
          () => captureBrowserScenario(provider, scenario, { signal }),
        );
        if (!captured.ok)
          return ok(
            createEvidence(undefined, provider.identity(), {
              operation: "analysis_execution_failure",
              predicateType: "rea.local-tool-failure",
              parameters: { tool: name, receipt_path: receiptPath },
              result: jsonValueSchema.parse({
                complete: false,
                diagnostic: projectAnalysisError(captured.error),
              }),
              rawResult: jsonValueSchema.parse({
                processes: structuredClone(processes),
              }),
              confidence: "observed",
              authority: "analyst-inference",
              limitations: [
                captured.error.message,
                "Failed capture and its process observations do not establish complete browser behavior.",
              ],
            }),
          );
        const source = captured.value;
        return ok(
          createEvidence(undefined, source.provider, {
            operation: source.operation,
            predicateType: source.predicate_type,
            parameters: source.parameters,
            result: source.normalized_result,
            rawResult: jsonValueSchema.parse({
              processes: structuredClone(processes),
              receipt_path: receiptPath,
            }),
            confidence: source.confidence,
            authority: source.authority,
            environment: source.environment,
            locations: source.locations,
            limitations: source.limitations,
            evidenceLinks: source.evidence_links,
          }),
        );
      } finally {
        try {
          await this.#release({
            close: () => provider.close?.() ?? Promise.resolve(),
          });
        } finally {
          await writeFile(receiptPath, JSON.stringify({ processes }, null, 2), {
            flag: "wx",
          });
        }
      }
    }
    const input = viewInput.parse(raw);
    const selected = sources.find(
      (item) => item.evidence_id === input.evidence_id,
    );
    if (!selected) throw new Error("Analysis views require assigned Evidence");
    return inspectStructuredView(selected, input.view);
  }
}
