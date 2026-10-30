import { AsyncLocalStorage } from "node:async_hooks";
import {
  ROOT_CONTEXT, SpanStatusCode, trace,
  type Attributes, type Counter, type Histogram, type MeterProvider,
  type Span, type TracerProvider,
} from "@opentelemetry/api";
import { localToolDefinitions } from "./contracts.js";
import { analysisToolDefinitions } from "./analysis/contracts.js";
import { researchToolDefinitions } from "./research/contracts.js";

type Operation = "investigation" | "model.request" | "analysis.call" | "evidence.retain" | "cancellation";
type Outcome = "ok" | "error" | "completed" | "failed" | "limited" | "cancelled";
type Labels = { role?: "analyst" | "reviewer" | "specialist"; tool?: string; reason?: "caller" | "shutdown" | "deadline" };
type Provider<T> = T & { forceFlush(): Promise<void>; shutdown(): Promise<void> };
export interface Observation {
  within<T>(work: () => T): T;
  finish(outcome?: Outcome): void;
}
const tools = new Set([
  ...localToolDefinitions.map((item) => item.name),
  ...analysisToolDefinitions.map((item) => item.name),
  ...researchToolDefinitions.map((item) => item.name),
  "read_feature_project", "revise_feature_project", "attach_feature_evidence",
  "compare_browser_scenario_evidence",
]);
const noop: Observation = { within: (work) => work(), finish: () => {} };

/** Private providers and an explicit allowlist: no global instrumentation or payloads. */
export class Telemetry {
  readonly #context = new AsyncLocalStorage<Span>();
  readonly #tracer;
  readonly #operations: Counter | undefined;
  readonly #duration: Histogram | undefined;
  readonly #tokens: Counter | undefined;
  readonly #cost: Counter | undefined;
  #closed = false;
  constructor(
    private readonly providers?: {
      traces: Provider<TracerProvider>;
      metrics: Provider<MeterProvider>;
    },
  ) {
    this.#tracer = providers?.traces.getTracer("rea-mcp-app", "0.1.0");
    const meter = providers?.metrics.getMeter("rea-mcp-app", "0.1.0");
    this.#operations = meter?.createCounter("rea.operations", { description: "Finished operations by outcome" });
    this.#duration = meter?.createHistogram("rea.operation.duration", { unit: "s" });
    this.#tokens = meter?.createCounter("rea.model.tokens", { unit: "{token}", description: "Only provider-reported token usage" });
    this.#cost = meter?.createCounter("rea.model.cost", { unit: "USD", description: "Only provider-reported cost; not a billing ledger" });
  }
  get enabled(): boolean { return this.providers !== undefined && !this.#closed; }
  start(operation: Operation, labels: Labels = {}): Observation {
    if (!this.#tracer || this.#closed) return noop;
    const attributes: Attributes = {};
    if (labels.role && ["analyst", "reviewer", "specialist"].includes(labels.role)) attributes["rea.role"] = labels.role;
    if (labels.tool && tools.has(labels.tool)) attributes["rea.tool"] = labels.tool;
    if (labels.reason && ["caller", "shutdown", "deadline"].includes(labels.reason)) attributes["rea.cancel.reason"] = labels.reason;
    const parent = this.#context.getStore();
    const span = this.#tracer.startSpan(`rea.${operation}`, { attributes }, parent ? trace.setSpan(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
    const started = performance.now();
    let finished = false;
    return {
      within: (work) => this.#context.run(span, work),
      finish: (outcome = "ok") => {
        if (finished) return;
        finished = true;
        // Never record exceptions: messages/stacks can contain caller paths and secrets.
        const safe = ["ok", "error", "completed", "failed", "limited", "cancelled"].includes(outcome) ? outcome : "error";
        span.setAttribute("rea.outcome", safe);
        span.setStatus({ code: safe === "error" || safe === "failed" ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        const dimensions = { ...attributes, "rea.operation": operation, "rea.outcome": safe };
        this.#operations?.add(1, dimensions);
        this.#duration?.record((performance.now() - started) / 1000, dimensions);
        span.end();
      },
    };
  }
  sync<T>(operation: Operation, work: () => T): T {
    const observation = this.start(operation);
    try { const result = observation.within(work); observation.finish(); return result; }
    catch (error) { observation.finish("error"); throw error; }
  }
  async result<T extends { ok: boolean }>(operation: Operation, labels: Labels, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const observation = this.start(operation, labels);
    try {
      const result = await observation.within(work);
      observation.finish(signal?.aborted ? "cancelled" : result.ok ? "ok" : "error");
      return result;
    } catch (error) { observation.finish(signal?.aborted ? "cancelled" : "error"); throw error; }
  }
  usage(input: number | null, output: number | null, cost: number | null, role: "analyst" | "reviewer") {
    if (this.#closed) return;
    for (const [direction, value] of [["input", input], ["output", output]] as const)
      if (value !== null && Number.isFinite(value) && value >= 0)
        this.#tokens?.add(value, { "rea.role": role, "rea.token.direction": direction });
    if (cost !== null && Number.isFinite(cost) && cost >= 0) this.#cost?.add(cost, { "rea.role": role });
  }
  async flush(): Promise<void> {
    if (this.#closed) return;
    await Promise.allSettled([this.providers?.traces.forceFlush(), this.providers?.metrics.forceFlush()]);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([this.providers?.traces.shutdown(), this.providers?.metrics.shutdown()]);
    this.#context.disable();
  }
}

export async function configuredTelemetry(environment: Readonly<NodeJS.ProcessEnv>): Promise<Telemetry> {
  if (environment.REA_OTEL_ENABLED !== "true") return new Telemetry();
  // No implicit collector, environment/resource detection, console output or auto-instrumentation.
  let endpoint: URL;
  try {
    endpoint = new URL(environment.REA_OTEL_ENDPOINT ?? "");
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error();
  } catch { throw new Error("REA_OTEL_ENDPOINT must be an explicit HTTP(S) collector base URL without credentials, query or fragment"); }
  const [{ TracerProvider, BatchSpanProcessor, AlwaysOnSampler }, { MeterProvider, PeriodicExportingMetricReader }, { resourceFromAttributes }, { OTLPTraceExporter }, { OTLPMetricExporter }] = await Promise.all([
    import("@opentelemetry/sdk-trace"), import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resources"), import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
  ]);
  const base = endpoint.href.replace(/\/$/, "");
  const resource = resourceFromAttributes({ "service.name": "rea-mcp-app", "service.version": "0.1.0" });
  const traces = new TracerProvider({
    resource, sampler: new AlwaysOnSampler(),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: {}, timeoutMillis: 1000 }), maxQueueSize: 512, maxExportBatchSize: 64, scheduledDelayMillis: 5000, exportTimeoutMillis: 1500 })],
  });
  const metrics = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers: {}, timeoutMillis: 1000 }),
    exportIntervalMillis: 10000, exportTimeoutMillis: 1500,
  })] });
  return new Telemetry({ traces, metrics });
}
