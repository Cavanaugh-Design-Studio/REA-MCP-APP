import { randomUUID, createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { deviceInput } from "./contracts.js";
import type { ScopedPath } from "./StructuredAnalysis.js";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../retained/process/OwnedCommand.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessSupervisor,
} from "../retained/process/ProviderProcess.js";
import { parsePngDimensions } from "../retained/adb/AdbShellOutput.js";
import { parseGetpropOutput } from "../retained/adb/AdbDeviceOutput.js";
import { createEvidence, type Evidence } from "../retained/domain/evidence.js";
import { jsonValueSchema } from "../retained/domain/jsonValue.js";
import { analysisEnvironment } from "./environment.js";
import { DOMParser } from "@xmldom/xmldom";

/** Device acquisition parses actual output and preserves binary bytes and ownership. */
export class DeviceCapture {
  readonly #selected: string;
  constructor(
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
    private readonly owners: Set<ProviderProcessSupervisor>,
    private readonly executable: (command: string) => Promise<string>,
    private readonly launcher: typeof spawnOwnedProviderProcess = spawnOwnedProviderProcess,
  ) {
    this.#selected = environment.REA_ADB_PATH ?? "adb";
    this.environment = analysisEnvironment(environment);
  }
  async capture(
    raw: unknown,
    path: ScopedPath,
    root: string,
    signal: AbortSignal,
  ): Promise<Evidence> {
    const input = deviceInput.parse(raw);
    const binary = await this.executable(this.#selected);
    const output =
      input.output_path ??
      `captures/${input.capture}-${randomUUID()}.${input.capture === "screen" ? "png" : input.capture === "ui" ? "xml" : "txt"}`;
    const localPath = await path(output, true);
    await mkdir(dirname(localPath), { recursive: true });
    const file = await open(localPath, "wx");
    try {
      const maximum =
        input.capture === "screen" ? 32 * 1024 * 1024 : 4 * 1024 * 1024;
      const args = [
        "-s",
        input.serial,
        ...(input.capture === "screen"
          ? ["exec-out", "screencap", "-p"]
          : input.capture === "ui"
            ? ["exec-out", "uiautomator", "dump", "/dev/tty"]
            : input.capture === "logcat"
              ? ["logcat", "-d", "-t", String(input.count)]
              : ["shell", "getprop"]),
      ];
      const chunks: Buffer[] = [];
      let bytes = 0;
      const run = async () =>
        await runOwnedCommand(
          {
            command: binary,
            arguments: args,
            cwd: root,
            runId: `device-${randomUUID()}`,
            hostEnvironment: this.environment,
          },
          { timeoutMs: 60000, diagnosticBytes: maximum },
          {
            signal,
            launcher: async (options) => {
              const launched = await this.launcher(options);
              launched.process.stdout?.on("data", (chunk: Buffer | string) => {
                const value = Buffer.isBuffer(chunk)
                  ? chunk
                  : Buffer.from(chunk);
                const count = Math.min(
                  value.length,
                  Math.max(0, maximum - bytes),
                );
                if (count) chunks.push(Buffer.from(value.subarray(0, count)));
                bytes += value.length;
              });
              return launched;
            },
          },
        );
      let snapshot, failure: OwnedCommandFailure | undefined;
      try {
        snapshot = await run();
      } catch (cause) {
        if (!(cause instanceof OwnedCommandFailure)) throw cause;
        failure = cause;
        snapshot = cause.snapshot;
        if (cause.cleanupOwner) this.owners.add(cause.cleanupOwner);
      }
      const data = Buffer.concat(chunks),
        sha256 = createHash("sha256").update(data).digest("hex");
      // Preserve exact bytes even if their declared format turns out malformed.
      await file.writeFile(data);
      const text = data.toString("utf8");
      const dimensions =
        input.capture === "screen" ? parsePngDimensions(data) : null;
      let hierarchy: {
        node_count: number;
        rotation: string;
        byte_start: number;
        byte_end: number;
      } | null = null;
      if (input.capture === "ui") {
        const start = text.indexOf("<hierarchy"),
          end = text.lastIndexOf("</hierarchy>") + "</hierarchy>".length;
        if (start >= 0 && end > start && !/<!DOCTYPE|<!ENTITY/iu.test(text)) {
          const issues: string[] = [];
          try {
            const document = new DOMParser({
              onError: (_level, message) => {
                issues.push(message);
              },
            }).parseFromString(text.slice(start, end), "application/xml");
            if (
              !issues.length &&
              document.documentElement?.tagName === "hierarchy"
            )
              hierarchy = {
                node_count: document.getElementsByTagName("node").length,
                rotation:
                  document.documentElement.getAttribute("rotation") ?? "",
                byte_start: Buffer.byteLength(text.slice(0, start)),
                byte_end: Buffer.byteLength(text.slice(0, end)),
              };
          } catch {
            /* Malformed XML remains a partial acquisition with exact raw bytes. */
          }
        }
      }
      const valid =
        input.capture === "screen"
          ? dimensions?.width !== null
          : input.capture === "ui"
            ? hierarchy !== null
            : true;
      const operation =
        input.capture === "screen"
          ? "capture_adb_screen"
          : input.capture === "logcat"
            ? "read_adb_logcat"
            : input.capture === "properties"
              ? "inspect_adb_device"
              : "capture_adb_ui";
      const observation = {
        serial: input.serial,
        local_path: localPath,
        bytes: data.length,
        sha256,
        format_valid: valid,
        complete: !failure && valid,
        cleanup: failure?.cleanupFailure ?? "verified",
        failure: failure?.message ?? null,
        ...(dimensions ?? {}),
        ...(hierarchy ? { hierarchy } : {}),
        ...(input.capture === "properties"
          ? { properties: parseGetpropOutput(text) }
          : {}),
        coverage: !failure && valid ? "complete" : "partial",
      };
      return createEvidence(
        undefined,
        {
          id: "rea-owned-adb",
          name: "REA owned Android acquisition",
          version: "1",
        },
        {
          operation,
          predicateType: "rea.adb-capture",
          parameters: {
            serial: input.serial,
            capture: input.capture,
            requested_output_path: input.output_path ?? null,
            executable: binary,
            arguments: args,
          },
          result: jsonValueSchema.parse(observation),
          rawResult: jsonValueSchema.parse({
            ...snapshot,
            stdout: {
              file: localPath,
              bytes: data.length,
              sha256,
              encoding: "binary",
            },
          }),
          confidence: "observed",
          authority: "external-service",
          locations: [{ kind: "artifact-path", path: localPath }],
          limitations: [
            "This is one device-reported acquisition; it is not a controlled replay or proof of app behavior.",
            ...(!valid
              ? [
                  "Captured bytes did not validate as the requested format; raw output is retained.",
                ]
              : []),
          ],
        },
      );
    } finally {
      await file.close();
    }
  }
}
