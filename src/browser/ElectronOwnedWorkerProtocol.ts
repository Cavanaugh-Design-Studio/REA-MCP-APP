import { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { BROWSER_OBSERVATION_FAILURE_REASONS } from "../domain/browserObservationErrors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
  type ElectronActiveObservationResult,
} from "../domain/javascript/electronActiveObservation.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import type { Result } from "../domain/result.js";
import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const pendingCaptureSchema = electronActiveObservationResultSchema.extend({
  application: electronActiveObservationResultSchema.shape.application.extend({
    cleanup: z.literal("unverified"),
  }),
});
const context = {
  message: z.string(),
  capturedOutput: z
    .strictObject({
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
      stdout_bytes: z.number().optional(),
      stderr_bytes: z.number().optional(),
      exit_code: z.number().nullable().optional(),
      signal: z.string().nullable().optional(),
    })
    .transform((value) => ({
      stdout: value.stdout,
      stderr: value.stderr,
      truncated: value.truncated,
      ...(value.stdout_bytes === undefined
        ? {}
        : { stdout_bytes: value.stdout_bytes }),
      ...(value.stderr_bytes === undefined
        ? {}
        : { stderr_bytes: value.stderr_bytes }),
      ...(value.exit_code === undefined ? {} : { exit_code: value.exit_code }),
      ...(value.signal === undefined ? {} : { signal: value.signal }),
    }))
    .optional(),
  cleanup: z
    .strictObject({ reason: z.string(), resources: z.array(z.string()) })
    .optional(),
};
const errorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("browser"),
    reason: z.enum(BROWSER_OBSERVATION_FAILURE_REASONS),
    ...context,
  }),
  z.strictObject({
    kind: z.literal("adapter"),
    diagnostics: z.record(z.string(), jsonValueSchema).optional(),
    ...context,
  }),
]);
/** Worker facts cannot claim termination; only the retaining parent settles its job. */
export const electronOwnedWorkerReplySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    capture: pendingCaptureSchema,
  }),
  z.strictObject({
    status: z.literal("failed"),
    error: errorSchema,
    capture: pendingCaptureSchema.nullable(),
  }),
]);
export type ElectronOwnedWorkerReply = z.infer<
  typeof electronOwnedWorkerReplySchema
>;
/** Pipe input avoids command-line limits and preserves exact caller inputs. */
export const electronOwnedWorkerRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("capture"),
    input: electronActiveObservationInputSchema,
  }),
  z.strictObject({ kind: z.literal("cancel") }),
]);
/** Transfer facts and precise failure reasons before the parent terminates the job. */
export const projectElectronWorkerReply = (
  result: Result<ElectronActiveObservationResult, AnalysisError>,
  closeError?: unknown,
): ElectronOwnedWorkerReply => {
  const partial = result.ok
    ? result.value
    : result.error.partialObservation !== undefined &&
        "kind" in result.error.partialObservation &&
        result.error.partialObservation.kind === "electron-active-observation"
      ? result.error.partialObservation.capture
      : null;
  const capture =
    partial === null
      ? null
      : {
          ...partial,
          limitations: [
            ...partial.limitations,
            ...(closeError === undefined
              ? []
              : [
                  `Graceful Electron transport close failed; final cleanup belongs to the parent native job: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
                ]),
          ],
          application: {
            ...partial.application,
            cleanup: "unverified" as const,
          },
        };
  if (result.ok)
    return {
      status: "captured",
      capture: capture!,
    };
  const error = result.error;
  const details = {
    message: error.userMessage ?? error.message,
    ...(error.capturedOutput === undefined
      ? {}
      : { capturedOutput: error.capturedOutput }),
    ...(error.cleanup === undefined
      ? {}
      : {
          cleanup: {
            reason: error.cleanup.reason,
            resources: [...error.cleanup.resources],
          },
        }),
  };
  return {
    status: "failed",
    capture,
    error:
      error instanceof BrowserObservationError
        ? { kind: "browser", reason: error.reason, ...details }
        : {
            kind: "adapter",
            ...details,
            ...(error instanceof ProviderAdapterError &&
            error.diagnostics !== undefined
              ? { diagnostics: error.diagnostics }
              : {}),
          },
  };
};
/** Restore a tagged failure after the parent has proved process termination. */
export const restoreElectronWorkerError = (
  reply: Extract<ElectronOwnedWorkerReply, { status: "failed" }>,
): AnalysisError => {
  const options = {
    ...(reply.error.capturedOutput === undefined
      ? {}
      : { capturedOutput: reply.error.capturedOutput }),
    ...(reply.error.cleanup === undefined
      ? {}
      : { cleanup: reply.error.cleanup }),
    ...(reply.capture === null
      ? {}
      : {
          partialObservation: {
            kind: "electron-active-observation" as const,
            capture: {
              ...reply.capture,
              application: {
                ...reply.capture.application,
                cleanup: "terminated-owned-process" as const,
              },
            },
          },
        }),
  };
  return reply.error.kind === "browser"
    ? new BrowserObservationError(
        "capture_electron_scenario",
        reply.error.reason,
        { ...options, detail: reply.error.message },
      )
    : new ProviderAdapterError(
        PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
        "capture_electron_scenario",
        {
          ...options,
          userMessage: reply.error.message,
          ...(reply.error.diagnostics === undefined
            ? {}
            : { diagnostics: reply.error.diagnostics }),
        },
      );
};
