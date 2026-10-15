import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type {
  ElectronActiveObservationInput,
  ElectronActiveObservationResult,
} from "../domain/javascript/electronActiveObservation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import {
  electronOwnedWorkerReplySchema,
  restoreElectronWorkerError,
  type ElectronOwnedWorkerReply,
} from "./ElectronOwnedWorkerProtocol.js";
import { safeElectronEnvironment } from "./PlaywrightElectronActiveProvider.js";
import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const OPERATION = "capture_electron_scenario";
const workerPath = fileURLToPath(
  new URL("./electronOwnedWorkerProcess.js", import.meta.url),
);

/** Each Electron launch lives in one retained, atomically assigned native job. */
export class WindowsJobElectronActiveProvider implements ElectronActiveObservationPort {
  readonly #pending = new Map<string, SpawnedOwnedProviderProcess>();
  constructor(
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly spawn: typeof spawnOwnedProviderProcess = spawnOwnedProviderProcess,
  ) {}
  identity(): ProviderIdentity {
    return PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY;
  }

  async capture(
    input: ElectronActiveObservationInput,
    options: ExecutionOptions = {},
  ): Promise<Result<ElectronActiveObservationResult, AnalysisError>> {
    for (const [id, retained] of this.#pending) {
      const cleanup = await retained.cleanup?.();
      if (cleanup?.cleaned !== true)
        return err(
          this.#cleanupError(
            id,
            cleanup?.reason ?? "Native job cleanup is unavailable",
          ),
        );
      this.#pending.delete(id);
    }
    if (options.signal?.aborted)
      return err(new BrowserObservationError(OPERATION, "cancelled"));
    const id = randomUUID();
    let owner: SpawnedOwnedProviderProcess;
    try {
      owner = await this.spawn({
        command: process.execPath,
        arguments: [workerPath],
        runId: id,
        stdin: "pipe",
        hostEnvironment: {},
        env: safeElectronEnvironment(this.environment, id),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      return err(
        options.signal?.aborted
          ? new BrowserObservationError(OPERATION, "cancelled", { cause })
          : new BrowserObservationError(
              OPERATION,
              "process_ownership_unavailable",
              {
                cause,
                detail: cause instanceof Error ? cause.message : String(cause),
              },
            ),
      );
    }
    this.#pending.set(id, owner);
    let reply: ElectronOwnedWorkerReply | undefined;
    let failure: unknown;
    try {
      reply = await readWorkerReply(owner, input, options.signal);
    } catch (cause: unknown) {
      failure = cause;
    }
    const cleanup = await owner.cleanup?.();
    if (cleanup?.cleaned !== true)
      return err(
        this.#cleanupError(
          id,
          cleanup?.reason ?? "Native job cleanup is unavailable",
          reply,
        ),
      );
    this.#pending.delete(id);
    if (reply !== undefined) {
      if (reply.status === "failed")
        return err(restoreElectronWorkerError(reply));
      const capture = {
        ...reply.capture,
        application: {
          ...reply.capture.application,
          cleanup: "terminated-owned-process" as const,
        },
      };
      return options.signal?.aborted
        ? err(
            new BrowserObservationError(OPERATION, "cancelled", {
              partialObservation: {
                kind: "electron-active-observation",
                capture,
              },
            }),
          )
        : ok(capture);
    }
    return err(
      options.signal?.aborted
        ? new BrowserObservationError(OPERATION, "cancelled", {
            cause: failure,
          })
        : new ProviderAdapterError(this.identity().id, OPERATION, {
            cause: failure,
            userMessage:
              failure instanceof Error ? failure.message : String(failure),
          }),
    );
  }

  #cleanupError(
    id: string,
    reason: string,
    reply?: ElectronOwnedWorkerReply,
  ): BrowserObservationError {
    const capture = reply?.capture;
    return new BrowserObservationError(OPERATION, "cleanup_failed", {
      detail: `Windows Electron Job Object cleanup could not be verified: ${reason}. Its owner is retained for retry.`,
      cleanup: { reason, resources: [`run:${id}`, "windows-electron-job"] },
      ...(capture == null
        ? {}
        : {
            partialObservation: {
              kind: "electron-active-observation",
              capture,
            },
          }),
    });
  }
}

const readWorkerReply = (
  owner: SpawnedOwnedProviderProcess,
  input: ElectronActiveObservationInput,
  signal?: AbortSignal,
): Promise<ElectronOwnedWorkerReply> =>
  new Promise((resolve, reject) => {
    const child = owner.process;
    // Retained buffers, decoding, JSON parsing and schema cloning coexist.
    const capacity = Math.floor(getHeapStatistics().heap_size_limit / 16);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    const finish = (
      reply?: ElectronOwnedWorkerReply,
      cause?: unknown,
    ): void => {
      if (finished) return;
      finished = true;
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
      signal?.removeEventListener("abort", cancel);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      child.stdin?.off("error", onError);
      if (reply === undefined) reject(cause);
      else resolve(reply);
    };
    const onData = (chunk: Buffer): void => {
      if (bytes + chunk.length > capacity) {
        finish(
          undefined,
          new Error(
            "Electron worker reply exceeds available heap transfer capacity",
          ),
        );
        return;
      }
      bytes += chunk.length;
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const encoded = Buffer.concat(chunks, bytes).toString("utf8");
        const value: unknown = JSON.parse(encoded);
        finish(electronOwnedWorkerReplySchema.parse(value));
      } catch (cause: unknown) {
        finish(undefined, cause);
      }
    };
    const onExit = (): void => {
      finish(
        undefined,
        new Error("Electron worker exited without a complete reply"),
      );
    };
    const onError = (cause: Error): void => {
      finish(undefined, cause);
    };
    const cancel = (): void => {
      if (finished || cancellationTimer !== undefined) return;
      child.stdin?.write(Buffer.from('{"kind":"cancel"}\n'));
      cancellationTimer = setTimeout(
        () =>
          finish(
            undefined,
            new Error("Electron cancellation grace period expired"),
          ),
        15_000,
      );
    };
    child.stdout?.on("data", onData);
    child.stderr?.resume();
    child.on("exit", onExit);
    child.on("error", onError);
    child.stdin?.on("error", onError);
    signal?.addEventListener("abort", cancel, { once: true });
    if (child.stdin == null) {
      finish(
        undefined,
        new Error("Owned Electron worker has no protocol stdin"),
      );
      return;
    }
    child.stdin.write(
      Buffer.from(`${JSON.stringify({ kind: "capture", input })}\n`),
      (cause) => {
        if (cause != null) onError(cause);
      },
    );
    if (signal?.aborted) cancel();
  });
