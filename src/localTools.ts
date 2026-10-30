import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  lstat,
  readdir,
  realpath,
  writeFile,
  open,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { homedir } from "node:os";
import { createEvidence, type Evidence } from "./retained/domain/evidence.js";
import { jsonValueSchema } from "./retained/domain/jsonValue.js";
import {
  AnalysisProtocolError,
} from "./retained/domain/analysisErrorCore.js";
import { AnalysisError } from "./retained/domain/analysisErrorBase.js";
import { ok, err, type Result } from "./retained/domain/result.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "./retained/process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "./retained/process/ProviderProcess.js";
import {
  readFileSchema,
  writeFileSchema,
  runCommandSchema,
  listFilesSchema,
  type TaskInput,
  type InternalToolName,
} from "./contracts.js";
import { inspectAnalysisView } from "./retained/application/analysisView/AnalysisViewService.js";
import { StructuredAnalysis } from "./analysis/StructuredAnalysis.js";
import { DeviceCapture } from "./analysis/DeviceCapture.js";
import { analysisToolNames } from "./analysis/contracts.js";
import { closeOwnedBrowsers } from "./analysis/OwnedBrowser.js";
import {
  analysisExecutionContext,
  analysisEnvironment,
} from "./analysis/environment.js";
import { analysisInputErrorFromIssues } from "./retained/domain/inputIssueProjection.js";
import { z } from "zod";
import { BraveSearch, type WebSearchAllowance } from "./research/BraveSearch.js";
import { planReconstruction } from "./research/ReconstructionPlan.js";

const provider = {
  id: "leanrea-local",
  name: "REA owned local tools",
  version: "0.1.0",
};
export interface RunWorkspace {
  root: string;
  target: string | null;
  originalTarget: string | null;
  inventory: Evidence | null;
  maxBytes: number;
  webSearch?: WebSearchAllowance;
}
const digestFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
};
const inside = (root: string, path: string) => {
  const value = relative(root, path);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
};

/** Reuses REA's retained handle/process-group authority, including failed owners. */
export class LocalTools {
  readonly #pending = new Set<ProviderProcessSupervisor>();
  readonly #analysis: StructuredAnalysis;
  readonly #device: DeviceCapture;
  readonly #search: BraveSearch;
  capabilities() {
    return {
      javascript_graphs: "implemented",
      managed_metadata_cil_graphs: "implemented",
      reconstruction_planning: "inferred-blueprints-with-reference-and-coverage-checks",
      web_search: this.#search.configured ? "brave-configured-caller-opt-in-required" : "requires-server-side-brave-key",
      owned_browser_capture: "caller-selected-executable",
      native_decompilation: this.environment.REA_GHIDRA_INSTALL_DIR
        ? "configured-not-probed"
        : "requires-caller-installed-ghidra-and-jdk",
      device_capture: this.environment.REA_ADB_PATH
        ? "configured-not-probed"
        : "requires-caller-installed-adb-and-selected-device",
    };
  }
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv>, searchFetch?: typeof fetch) {
    this.#search = new BraveSearch(environment.BRAVE_SEARCH_API_KEY, searchFetch);
    const safe = analysisEnvironment(environment);
    const configured = {
      ...safe,
      ...(environment.REA_GHIDRA_INSTALL_DIR
        ? { REA_GHIDRA_INSTALL_DIR: environment.REA_GHIDRA_INSTALL_DIR }
        : {}),
      ...(environment.REA_GHIDRA_JAVA_HOME
        ? { REA_GHIDRA_JAVA_HOME: environment.REA_GHIDRA_JAVA_HOME }
        : {}),
    };
    this.#analysis = new StructuredAnalysis(configured);
    this.#device = new DeviceCapture(
      {
        ...safe,
        ...(environment.REA_ADB_PATH
          ? { REA_ADB_PATH: environment.REA_ADB_PATH }
          : {}),
      },
      this.#pending,
      (command) => this.resolveExecutable(command, safe),
    );
  }
  async prepare(
    id: string,
    input: TaskInput,
    signal: AbortSignal,
  ): Promise<RunWorkspace> {
    if (input.workspace && !isAbsolute(input.workspace))
      throw new Error("workspace must be an absolute local path");
    const parent = input.workspace ?? join(homedir(), ".rea-mcp-app", "runs");
    await mkdir(parent, { recursive: true });
    const root = join(await realpath(parent), id);
    await mkdir(root);
    const research = input.allow_web_search ? {
      webSearch: {
        remaining: input.max_web_searches,
        sensitiveValues: [...input.sensitive_values, ...Object.entries(this.environment)
          .filter(([key, value]) => /api[_-]?key|token|password|secret/iu.test(key) && Boolean(value))
          .map(([, value]) => value!)],
      },
    } : {};
    const target = input.target;
    if (!target)
      return {
        root,
        target: null,
        originalTarget: null,
        inventory: null,
        maxBytes: input.budget.max_context_bytes,
        ...research,
      };
    if (/^https?:\/\//u.test(target))
      return {
        root,
        target,
        originalTarget: target,
        inventory: null,
        maxBytes: input.budget.max_context_bytes,
        ...research,
      };
    if (!isAbsolute(target))
      throw new Error(
        "target must be an absolute local path or explicit HTTP(S) URL",
      );
    const original = await realpath(target);
    if (inside(original, root))
      throw new Error(
        "Run workspace cannot be nested inside the selected target directory",
      );
    const destination = join(root, "input", basename(original));
    await mkdir(dirname(destination));
    let bytes = 0;
    await cp(original, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      filter: async (path) => {
        signal.throwIfAborted();
        const info = await lstat(path);
        if (info.isSymbolicLink())
          throw new Error(
            "Selected input contains a symbolic link; provide a self-contained working copy",
          );
        if (info.isFile()) bytes += info.size;
        if (bytes > input.max_copy_bytes)
          throw new Error(
            "Input copy reached max_copy_bytes; partial working copy is retained",
          );
        return true;
      },
    });
    const info = await lstat(destination);
    const sha256 = info.isFile() ? await digestFile(destination) : null;
    const inventory = createEvidence(undefined, provider, {
      operation: "prepare_working_copy",
      predicateType: "rea.local-working-copy",
      parameters: {
        source_path: target,
        working_path: destination,
        max_copy_bytes: input.max_copy_bytes,
      },
      result: {
        source_path: target,
        resolved_source_path: original,
        working_path: destination,
        copied_bytes: bytes,
        kind: info.isDirectory() ? "directory" : "file",
        copied_sha256: sha256,
      },
      limitations: [
        "Copying a live target is not an atomic filesystem snapshot. No runtime behavior has been observed.",
      ],
      locations: [{ kind: "artifact-path", path: destination }],
    });
    return {
      root,
      target: destination,
      originalTarget: target,
      inventory,
      maxBytes: input.budget.max_context_bytes,
      ...research,
    };
  }
  async #path(
    workspace: RunWorkspace,
    supplied: string,
    writing = false,
  ): Promise<string> {
    const requested = resolve(workspace.root, supplied);
    if (!inside(workspace.root, requested))
      throw new Error("File operation lies outside the owned run workspace");
    let resolved: string;
    try {
      resolved = await realpath(requested);
    } catch (cause) {
      if (
        !writing ||
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      )
        throw cause;
      let parent = dirname(requested);
      while (true) {
        try {
          resolved = await realpath(parent);
          break;
        } catch (failure) {
          if (parent === dirname(parent)) throw failure;
          parent = dirname(parent);
        }
      }
    }
    if (!inside(workspace.root, resolved!))
      throw new Error(
        "File operation follows a link outside the owned run workspace",
      );
    return requested;
  }
  async execute(
    name: InternalToolName,
    raw: unknown,
    workspace: RunWorkspace,
    runId: string,
    signal: AbortSignal,
    sources: readonly Evidence[],
  ): Promise<Result<Evidence, AnalysisError>> {
    try {
      signal.throwIfAborted();
      if (this.#pending.size)
        throw new Error(
          "An owned command has unresolved cleanup; retry cleanup before further execution",
        );
      if (name === "search_web")
        return ok(await this.#search.search(raw, workspace.webSearch, workspace.maxBytes, signal));
      if (name === "plan_reconstruction")
        return ok(planReconstruction(raw, sources, workspace.maxBytes));
      if (analysisToolNames.has(name)) {
        const scoped = (path: string, writing = false) =>
          this.#path(workspace, path, writing);
        if (name === "capture_device")
          return ok(
            await this.#device.capture(raw, scoped, workspace.root, signal),
          );
        return await analysisExecutionContext.run(
          {
            environment: analysisEnvironment(this.environment),
            parent: workspace.root,
          },
          () =>
            this.#analysis.execute(
              name,
              raw,
              workspace.target,
              scoped,
              runId,
              signal,
              sources,
              workspace.root,
            ),
        );
      }
      if (name === "inspect_analysis_view")
        return inspectAnalysisView(raw, (id) =>
          sources.find((item) => item.evidence_id === id),
        );
      if (name === "run_command") {
        const input = runCommandSchema.parse(raw);
        if (input.max_output_bytes > workspace.maxBytes)
          throw new Error(
            "Command output budget exceeds this run's caller-selected context byte budget",
          );
        const cwd = input.cwd
          ? await this.#path(workspace, input.cwd)
          : workspace.root;
        const env: NodeJS.ProcessEnv = {};
        const allowed = new Set([
          "path",
          "pathext",
          "systemroot",
          "windir",
          "comspec",
          "temp",
          "tmp",
          "tmpdir",
          "home",
          "userprofile",
          "localappdata",
          "appdata",
          "lang",
          "lc_all",
        ]);
        for (const [key, value] of Object.entries(this.environment))
          if (allowed.has(key.toLowerCase()) && value !== undefined)
            env[key] = value;
        const executable = await this.resolveExecutable(input.executable, env);
        let snapshot;
        let failure: OwnedCommandFailure | undefined;
        try {
          snapshot = await runOwnedCommand(
            {
              command: executable,
              arguments: input.arguments,
              runId: `${runId}-${randomUUID()}`,
              cwd,
              hostEnvironment: env,
            },
            {
              timeoutMs: input.timeout_ms,
              diagnosticBytes: input.max_output_bytes,
              acceptNonZeroExit: true,
            },
            { signal },
          );
        } catch (cause) {
          if (!(cause instanceof OwnedCommandFailure)) throw cause;
          failure = cause;
          snapshot = cause.snapshot;
          if (cause.cleanupOwner) this.#pending.add(cause.cleanupOwner);
        }
        return ok(
          createEvidence(undefined, provider, {
            operation: "run_local_command",
            predicateType: "rea.local-command",
            authority: "controlled-replay",
            parameters: {
              executable: input.executable,
              resolved_executable: executable,
              arguments: input.arguments,
              cwd,
              timeout_ms: input.timeout_ms,
              max_output_bytes: input.max_output_bytes,
            },
            result: jsonValueSchema.parse({
              ...snapshot,
              exitCode: snapshot?.exitCode ?? null,
              signal: snapshot?.signal ?? null,
              complete: failure === undefined,
              cleanup: failure?.cleanupFailure ?? "verified",
              failure: failure?.message ?? null,
            }),
            limitations: [
              ...(failure ? [failure.message] : []),
              "This observes this command invocation only; output claims about other processes or artifacts require their own evidence.",
            ],
            locations: [{ kind: "artifact-path", path: cwd }],
          }),
        );
      }
      if (name === "read_file") {
        const input = readFileSchema.parse(raw),
          path = await this.#path(workspace, input.path);
        if (input.length > workspace.maxBytes)
          throw new Error(
            "File slice exceeds this run's caller-selected context byte budget",
          );
        const file = await open(path, "r");
        try {
          const before = await file.stat();
          const length = Math.min(
            input.length,
            Math.max(0, before.size - input.offset),
          );
          const bytes = Buffer.alloc(length),
            result = await file.read(bytes, 0, length, input.offset);
          const hash = createHash("sha256");
          for await (const part of file.createReadStream({
            start: 0,
            autoClose: false,
          }))
            hash.update(part);
          const sha256 = hash.digest("hex"),
            after = await file.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error(
              "File changed while its slice and digest were being observed",
            );
          return ok(
            createEvidence(undefined, provider, {
              operation: "read_local_file",
              predicateType: "rea.local-file-view",
              parameters: { path, offset: input.offset, length: input.length },
              result: {
                path,
                sha256,
                total_bytes: before.size,
                offset: input.offset,
                bytes: result.bytesRead,
                encoding: "utf8",
                text: bytes.subarray(0, result.bytesRead).toString("utf8"),
                base64: bytes.subarray(0, result.bytesRead).toString("base64"),
                next_offset:
                  input.offset + result.bytesRead < before.size
                    ? input.offset + result.bytesRead
                    : null,
              },
              locations: [
                { kind: "artifact-path", path },
                {
                  kind: "file-offset-range",
                  start: input.offset,
                  end: input.offset + result.bytesRead,
                },
              ],
              limitations: [
                "A byte slice does not establish unread content or runtime behavior.",
              ],
            }),
          );
        } finally {
          await file.close();
        }
      }
      if (name === "write_file") {
        const input = writeFileSchema.parse(raw),
          path = await this.#path(workspace, input.path, true);
        let existing: string | null = null;
        try {
          existing = await digestFile(path);
        } catch (cause) {
          if (
            !(cause instanceof Error) ||
            !("code" in cause) ||
            cause.code !== "ENOENT"
          )
            throw cause;
        }
        if (existing !== null && existing !== input.expected_sha256)
          throw new Error(
            "Existing workspace file requires its exact expected_sha256",
          );
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, input.content, {
          flag: existing === null ? "wx" : "w",
        });
        return ok(
          createEvidence(undefined, provider, {
            operation: "write_local_file",
            predicateType: "rea.local-file-write",
            parameters: {
              path,
              expected_sha256: input.expected_sha256 ?? null,
            },
            result: {
              path,
              sha256: await digestFile(path),
              bytes: Buffer.byteLength(input.content),
              previous_sha256: existing,
            },
            locations: [{ kind: "artifact-path", path }],
            limitations: [
              "Written implementation bytes have not been executed or verified.",
            ],
          }),
        );
      }
      const input = listFilesSchema.parse(raw),
        path = await this.#path(workspace, input.path);
      const all = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      );
      const entries = all
        .slice(input.offset, input.offset + input.limit)
        .map((item) => ({
          name: item.name,
          kind: item.isDirectory()
            ? "directory"
            : item.isSymbolicLink()
              ? "symlink"
              : "file",
        }));
      return ok(
        createEvidence(undefined, provider, {
          operation: "list_local_files",
          predicateType: "rea.local-directory-view",
          parameters: { path, offset: input.offset, limit: input.limit },
          result: {
            path,
            entries,
            total: all.length,
            next_offset:
              input.offset + entries.length < all.length
                ? input.offset + entries.length
                : null,
          },
          limitations: [
            "This lists one directory; nested contents remain unexamined.",
          ],
          locations: [{ kind: "artifact-path", path }],
        }),
      );
    } catch (cause) {
      return err(
        cause instanceof AnalysisError
          ? cause
          : cause instanceof z.ZodError
            ? analysisInputErrorFromIssues(name, cause.issues, raw, { cause })
            : new AnalysisProtocolError(
                cause instanceof Error ? cause.message : "Local tool failed",
              ),
      );
    }
  }
  async resolveExecutable(
    command: string,
    environment: NodeJS.ProcessEnv = this.environment,
  ): Promise<string> {
    if (isAbsolute(command)) {
      const path = await realpath(command);
      if (!(await lstat(path)).isFile())
        throw new Error("Executable is not a regular file");
      return path;
    }
    if (command.includes("/") || command.includes("\\"))
      throw new Error("Use an absolute executable path or a name on PATH");
    const path =
      Object.entries(environment).find(
        ([key]) => key.toLowerCase() === "path",
      )?.[1] ?? "";
    const extensions =
      process.platform === "win32" ? ["", ".exe", ".com"] : [""];
    for (const directory of path.split(
      process.platform === "win32" ? ";" : ":",
    ))
      for (const extension of extensions) {
        if (!directory) continue;
        const candidate = join(directory, command + extension);
        try {
          if ((await lstat(candidate)).isFile())
            return await realpath(candidate);
        } catch {
          /* Try the next explicit PATH location. */
        }
      }
    throw new Error(
      `Required executable is unavailable: ${command}. Configure an absolute installed executable; no software was installed.`,
    );
  }
  async close(): Promise<void> {
    const failures: string[] = [];
    for (const cleanup of [
      () => this.#analysis.close(),
      () => closeOwnedBrowsers(),
    ]) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : String(cause));
      }
    }
    for (const owner of this.#pending) {
      const result = await owner.stop();
      if (result.status === "incomplete") failures.push(result.reason);
      else this.#pending.delete(owner);
    }
    if (failures.length)
      throw new Error(
        `Owned cleanup remains incomplete: ${failures.join("; ")}`,
      );
  }
}
