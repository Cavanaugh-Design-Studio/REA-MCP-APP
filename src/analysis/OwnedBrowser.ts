import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type LaunchOptions,
  type BrowserContextOptions,
} from "playwright-core";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
} from "../retained/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../retained/process/ProcessOwnership.js";
import { AnalysisProtocolError } from "../retained/domain/analysisErrorCore.js";
import { analysisExecutionContext } from "./environment.js";

const failed = new Set<ProviderProcessSupervisor>();
export async function closeOwnedBrowsers(): Promise<void> {
  for (const owner of failed) {
    const result = await owner.stop();
    if (result.status === "incomplete") throw new Error(result.reason);
    failed.delete(owner);
  }
}

/** Launch with retained authority first; CDP is only a control transport. */
export async function launchOwnedBrowser(
  profile: string,
  options: LaunchOptions & BrowserContextOptions,
  signal?: AbortSignal,
): Promise<BrowserContext> {
  if (failed.size) throw new Error("An owned browser has unresolved cleanup");
  if (!options.executablePath)
    throw new Error("Select an installed browser executable");
  const args = [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-breakpad",
    "--disable-features=AutoDeElevate",
    "--noerrdialogs",
    ...(options.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
  const launched = await spawnOwnedProviderProcess({
    command: options.executablePath,
    arguments: args,
    runId: `browser-${randomUUID()}`,
    hostEnvironment: options.env ?? {},
    ...(signal ? { signal } : {}),
  });
  const owner = new ProviderProcessSupervisor(
    {
      ...launched,
      ownsProcessLifetime: true,
      cleanup:
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership)),
    },
    { maxDiagnosticBytes: 131072 },
  );
  const receipt: Record<string, unknown> = {
    executable: options.executablePath,
    arguments: args,
    profile,
    cleanup: "pending",
  };
  analysisExecutionContext.getStore()?.processes?.push(receipt);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let context: BrowserContext | undefined;
  const stop = async () => {
    const failures: unknown[] = [];
    try {
      await context?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await browser?.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      const result = await owner.stop();
      receipt.output = owner.snapshot();
      receipt.cleanup = result;
      if (result.status === "incomplete") {
        failed.add(owner);
        failures.push(new Error(result.reason));
      }
    } catch (cause) {
      failed.add(owner);
      failures.push(cause);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned browser cleanup could not complete every action",
      );
  };
  try {
    const deadline = Date.now() + 20000;
    let endpoint: string | undefined;
    while (!endpoint) {
      signal?.throwIfAborted();
      const state = owner.snapshot();
      if (
        (state.exitCode !== null && state.exitCode !== undefined) ||
        Date.now() > deadline
      )
        throw new AnalysisProtocolError(
          `Owned browser did not establish CDP: ${JSON.stringify(state)}`,
        );
      try {
        const text = await readFile(
          join(profile, "DevToolsActivePort"),
          "utf8",
        );
        const port = Number(text.split(/\r?\n/u)[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535)
          endpoint = `http://127.0.0.1:${port}`;
      } catch (cause) {
        if (
          !(cause instanceof Error) ||
          !("code" in cause) ||
          cause.code !== "ENOENT"
        )
          throw cause;
      }
      if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    signal?.throwIfAborted();
    context = await browser.newContext({
      viewport: options.viewport ?? null,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      locale: options.locale ?? "en-US",
      timezoneId: options.timezoneId ?? "UTC",
      colorScheme: options.colorScheme ?? "light",
      reducedMotion: options.reducedMotion ?? "reduce",
      serviceWorkers: options.serviceWorkers ?? "block",
      acceptDownloads: false,
    });
    const ownedContext = context;
    // Retain the real context for protocol calls; only close gains process ownership.
    return new Proxy(ownedContext, {
      get(target, key) {
        if (key === "close") return stop;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } catch (cause) {
    await stop();
    throw cause;
  }
}
