import { randomUUID } from "node:crypto";
import {
  runOwnedCommand,
  OwnedCommandFailure,
} from "../retained/process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../retained/process/ProviderProcess.js";
const failed = new Set<ProviderProcessSupervisor>();
export async function closeGhidraLaunchSupport(): Promise<void> {
  for (const owner of failed) {
    const result = await owner.stop();
    if (result.status === "incomplete") throw new Error(result.reason);
    failed.delete(owner);
  }
}
/** Ghidra's release helper is an owned process, including failed startup. */
export async function inspectGhidraLaunchSettings(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  if (failed.size)
    throw new Error("Ghidra launch support cleanup remains incomplete");
  try {
    const snapshot = await runOwnedCommand(
      {
        command,
        arguments: args,
        runId: `ghidra-settings-${randomUUID()}`,
        hostEnvironment: options.env,
      },
      { timeoutMs: 15000, diagnosticBytes: 262144 },
      options.signal ? { signal: options.signal } : {},
    );
    return { stdout: snapshot.stdout.text, stderr: snapshot.stderr.text };
  } catch (cause) {
    if (cause instanceof OwnedCommandFailure && cause.cleanupOwner)
      failed.add(cause.cleanupOwner);
    throw cause;
  }
}
