import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi, type Mock } from "vitest";
import {
  electronActiveObservationInputSchema,
  electronActiveObservationResultSchema,
} from "../domain/javascript/electronActiveObservation.js";
import type {
  SpawnedOwnedProviderProcess,
  OwnedProviderProcessSpawnOptions,
} from "../process/ProviderProcess.js";
import type { ProcessCleanupResult } from "../process/ProcessOwnership.js";
import { WindowsJobElectronActiveProvider } from "./WindowsJobElectronActiveProvider.js";
import { projectElectronWorkerReply } from "./ElectronOwnedWorkerProtocol.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";

const input = electronActiveObservationInputSchema.parse({
  executable_path: process.execPath,
  application_path: process.execPath,
  args: ["caller value"],
});
const capture = electronActiveObservationResultSchema.parse({
  application: {
    executable_path: process.execPath,
    application_path: process.execPath,
    electron_version: "42.2.0",
    process_ownership: "provider-owned",
    cleanup: "terminated-owned-process",
  },
  actions: [],
  windows: [],
  processes: { items: [] },
  ipc: { events: [], observed: 0, dropped: 0 },
  timeline: { events: [], observed: 0, dropped: 0 },
  retention: {
    budget_bytes: 0,
    estimated_retained_bytes: 0,
    event_serialized_byte_upper_bound: 0,
    retained: 0,
    dropped: 0,
    dropped_event_families: [],
    dropped_event_roles: [],
    observed_ipc: 0,
    dropped_ipc: 0,
    observed_runtime: 0,
    dropped_runtime: 0,
  },
  coverage: {
    status: "partial_attach",
    observed_event_families: [],
    unavailable_event_families: [],
    observed_roles: [],
    pre_capture_activity: "unavailable",
  },
  limitations: [],
});
const pending = {
  ...capture,
  application: { ...capture.application, cleanup: "unverified" },
};
it("defers graceful-close failure to the native owner and preserves cancellation", () => {
  const closeError = new Error("graceful close timeout");
  const success = projectElectronWorkerReply(
    { ok: true, value: capture },
    closeError,
  );
  expect(success.status).toBe("captured");
  expect(success.capture?.application.cleanup).toBe("unverified");
  expect(success.capture?.limitations.join(" ")).toContain(
    "graceful close timeout",
  );
  const cancelled = projectElectronWorkerReply(
    {
      ok: false,
      error: new BrowserObservationError(
        "capture_electron_scenario",
        "cancelled",
        {
          partialObservation: { kind: "electron-active-observation", capture },
        },
      ),
    },
    closeError,
  );
  expect(cancelled.status).toBe("failed");
  if (cancelled.status !== "failed") throw new Error("Expected cancellation");
  expect(cancelled.error).toMatchObject({
    kind: "browser",
    reason: "cancelled",
  });
});
const fixture = (
  response: unknown,
  cleanup: Mock<() => Promise<ProcessCleanupResult>> = vi.fn(async () => ({
    cleaned: true as const,
    signaled: true,
  })),
) => {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  stdin.once("data", () =>
    queueMicrotask(() =>
      stdout.write(
        typeof response === "string"
          ? response
          : JSON.stringify(response) + "\n",
      ),
    ),
  );
  const owner = {
    process: Object.assign(events, {
      stdout,
      stdin,
      stderr,
      pid: 123,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }),
    ownership: { runId: "test", leaderPid: 123, processGroupId: 123 },
    cleanup,
  } satisfies SpawnedOwnedProviderProcess;
  const spawn = vi.fn(
    async (_options: OwnedProviderProcessSpawnOptions) => owner,
  );
  return { spawn, cleanup, stdin, owner };
};
it("returns success only after retained job cleanup and preserves exact input", async () => {
  const owned = fixture({ status: "captured", capture: pending });
  const provider = new WindowsJobElectronActiveProvider(
    {
      ...(process.platform === "win32"
        ? { Path: "selected", ComSpec: "C:/Windows/System32/cmd.exe" }
        : { PATH: "selected" }),
      OPENROUTER_API_KEY: "private",
    },
    owned.spawn,
  );
  let request = "";
  owned.stdin.on("data", (bytes) => {
    request += bytes.toString();
  });
  const result = await provider.capture(input);
  expect(result).toEqual({ ok: true, value: capture });
  expect(owned.cleanup).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request).input).toEqual(input);
  expect(owned.spawn.mock.calls[0]?.[0]).toMatchObject({
    hostEnvironment: {},
    env: { PATH: "selected" },
  });
  expect(owned.spawn.mock.calls[0]?.[0]?.env).not.toHaveProperty(
    "OPENROUTER_API_KEY",
  );
  if (process.platform === "win32")
    expect(owned.spawn.mock.calls[0]?.[0]?.env?.COMSPEC).toBe(
      "C:/Windows/System32/cmd.exe",
    );
});
it("retains failed cleanup ownership and blocks another launch until it settles", async () => {
  const cleanup = vi.fn(async () => ({
    cleaned: false as const,
    reason: "job active",
  }));
  const owned = fixture({ status: "captured", capture: pending }, cleanup);
  const provider = new WindowsJobElectronActiveProvider({}, owned.spawn);
  const first = await provider.capture(input);
  const second = await provider.capture(input);
  expect(first.ok).toBe(false);
  expect(second.ok).toBe(false);
  expect(owned.spawn).toHaveBeenCalledTimes(1);
  if (first.ok) throw new Error("Expected retained cleanup failure");
  expect(first.error.partialObservation).toMatchObject({
    capture: { application: { cleanup: "unverified" } },
  });
});
it("cleans the job after a malformed worker reply", async () => {
  const owned = fixture("broken\n");
  const result = await new WindowsJobElectronActiveProvider(
    {},
    owned.spawn,
  ).capture(input);
  expect(result.ok).toBe(false);
  expect(owned.cleanup).toHaveBeenCalledTimes(1);
});
it("preserves cancellation and partial observations after verified cleanup", async () => {
  const owned = fixture({
    status: "failed",
    capture: pending,
    error: { kind: "browser", reason: "cancelled", message: "cancelled" },
  });
  const result = await new WindowsJobElectronActiveProvider(
    {},
    owned.spawn,
  ).capture(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cancelled",
    partialObservation: {
      capture: { application: { cleanup: "terminated-owned-process" } },
    },
  });
});
it("does not launch when already cancelled", async () => {
  const owned = fixture({ status: "captured", capture: pending });
  const controller = new AbortController();
  controller.abort();
  const result = await new WindowsJobElectronActiveProvider(
    {},
    owned.spawn,
  ).capture(input, { signal: controller.signal });
  expect(result.ok).toBe(false);
  expect(owned.spawn).not.toHaveBeenCalled();
});
