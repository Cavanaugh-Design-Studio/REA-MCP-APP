import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import { PlaywrightElectronActiveProvider } from "../browser/PlaywrightElectronActiveProvider.js";
import { WindowsJobElectronActiveProvider } from "../browser/WindowsJobElectronActiveProvider.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createElectronScenarioProvider = (
  environment: Readonly<Record<string, string | undefined>>,
): ElectronActiveObservationPort =>
  process.platform === "win32"
    ? new WindowsJobElectronActiveProvider(environment)
    : new PlaywrightElectronActiveProvider(environment);
