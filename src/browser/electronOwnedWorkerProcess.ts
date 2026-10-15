import { createInterface } from "node:readline";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err } from "../domain/result.js";
import { PlaywrightElectronActiveProvider } from "./PlaywrightElectronActiveProvider.js";
import {
  electronOwnedWorkerRequestSchema,
  projectElectronWorkerReply,
  type ElectronOwnedWorkerReply,
} from "./ElectronOwnedWorkerProtocol.js";
import { PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY } from "./providerIdentities.js";

const controller = new AbortController();
let started = false;
let replied = false;
const writeReply = (reply: ElectronOwnedWorkerReply): void => {
  if (replied) return;
  replied = true;
  process.stdout.write(`${JSON.stringify(reply)}\n`);
};
// The parent atomically assigned this worker to a non-breakaway native job
// before it could launch Electron. The parent owns final process termination.
const provider = new PlaywrightElectronActiveProvider(
  process.env,
  undefined,
  (result, closeError) => {
    writeReply(projectElectronWorkerReply(result, closeError));
    return new Promise(() => {});
  },
);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const value: unknown = JSON.parse(line);
    const request = electronOwnedWorkerRequestSchema.parse(value);
    if (request.kind === "cancel") {
      controller.abort();
      return;
    }
    if (started) throw new Error("Electron worker accepts one capture");
    started = true;
    void provider.capture(request.input, { signal: controller.signal }).then(
      (result) => {
        writeReply(projectElectronWorkerReply(result));
        lines.close();
      },
      (cause: unknown) => {
        fail(cause);
        lines.close();
      },
    );
  } catch (cause: unknown) {
    fail(cause);
    controller.abort();
  }
});
lines.on("close", () => {
  if (!replied) controller.abort();
});
function fail(cause: unknown): void {
  writeReply(
    projectElectronWorkerReply(
      err(
        new ProviderAdapterError(
          PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY.id,
          "capture_electron_scenario",
          {
            userMessage: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      ),
    ),
  );
}
