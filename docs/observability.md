# OpenTelemetry

Telemetry is disabled by default. It uses manually instrumented, private
OpenTelemetry providers; it does not register global providers, patch HTTP or
filesystem APIs, instrument the browser, or export logs to stdout. MCP stdio
remains reserved for protocol messages.

Configure the server environment or explicitly selected private env file:

```dotenv
REA_OTEL_ENABLED=true
REA_OTEL_ENDPOINT=http://127.0.0.1:4318
```

Restart/reconnect after changes. Supply your own collector with an OTLP/HTTP
JSON receiver. REA appends `/v1/traces` and `/v1/metrics` to the base URL. It
does not start or install a collector. An enabled configuration with a missing
or invalid endpoint fails startup with a configuration error. The endpoint
must use HTTP(S) and contain no URL credentials, query or fragment. Prefer a
local collector; use HTTPS for remote transport. Standard OpenTelemetry
exporter headers and TLS environment settings are handled by the exporters
in the server process, including authentication when configured. They are not
copied into spans, metrics, or analysis child environments. The workbench
status response reports whether telemetry is enabled, without its destination.

Each investigation has its own root trace. Child spans record model request,
analysis call, Evidence retention, and cancellation durations. Cancellation
starts on caller cancellation, deadline or shutdown and ends when the run
settles. Existing process ownership and failed-cleanup behavior remain
authoritative. Instrumentation does not terminate processes.

| Measurement | Meaning |
| --- | --- |
| `rea.operations` | Finished operations by fixed operation name and outcome |
| `rea.operation.duration` | Operation latency in seconds, including cancellation drain |
| `rea.model.tokens` | Provider-reported input/output tokens by analyst/reviewer role |
| `rea.model.cost` | Provider-reported USD cost; absent when cost is unknown |

Exported attributes are limited to fixed operation, role, tool, outcome and
cancellation-reason values. Model identifiers, provider-returned names, run
IDs, Evidence IDs, questions, prompts, skill text, arguments, executable names,
paths, URLs from targets, artifact/output contents and exception messages or
stacks are excluded. The resource identifies only this application and version.
No host, environment or process resource detector is enabled. Tool names come
from REA's authored internal contracts, not arbitrary model output.

Successful HTTP/model transport does not establish a successful investigation.
Read the root investigation outcome and canonical Evidence separately. Unknown
usage is omitted, not treated as zero. Metrics do not replace the spend ledger,
Evidence store, deterministic verification or parity acceptance gates.

Traces use a bounded 512-span batch queue, 64-span export batches and a
five-second export interval. Metrics export every ten seconds. Exports use
one-second request timeouts and 1.5-second processing timeouts. Shutdown drains
investigations before closing telemetry. Collector failure is best-effort:
exports can be dropped and do not change investigation results or cleanup.

Validation covers real OTLP JSON delivery to a local collector, trace parenting,
success/failure/cancellation, numeric usage, unknown-cost omission, sensitive
fixture exclusion, and a nonresponsive collector. No hosted telemetry backend
or live model is required for these checks.

Implementation follows the OpenTelemetry JavaScript
[instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
and [exporter](https://opentelemetry.io/docs/languages/js/exporters/) guidance.
