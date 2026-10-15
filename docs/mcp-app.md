# Investigation workbench and optional AI team

For the completed Windows Electron integration and 30-trial live comparison,
see [final acceptance and benchmarking](feature-benchmark.md). Specialist mode
remains optional: the comparison did not meet its time-improvement target.

REA's MCP server ships an interactive App at `ui://rea/workbench.html`, delivered as
`text/html;profile=mcp-app`. Call `rea_workbench` in a session-based server to open
it. Compatible MCP Apps hosts render it; other clients still receive ordinary
JSON tool results. REA continues to use stdio. The fullscreen fallback opens a
restricted, authenticated loopback browser view on demand; no public HTTP server
or tunnel is required.

The workbench uses slate surfaces with blue for observations, violet for
interpretations, amber for uncertainty, and rose for failures. Labels accompany
every color. It supports light/dark host themes, safe-area insets and portable
fullscreen when the host advertises it.

The App declares both inline and fullscreen support during initialization. Its
Fullscreen button stays visible in every host. If a host omits, declines or times
out fullscreen, REA creates a browser handoff and asks the host to open it. If the
host cannot open links, copy the displayed URL into a browser within 60 seconds.
The browser view shares the same live connection, Evidence and investigation
runs, and restores the App's form, selected sources, active view and run. Keep the
original chat open. Host messages and filesystem bundle operations remain in the
original App; report downloads and investigation controls work in the browser.
The top-level browser view can use the browser's Fullscreen API, and Escape
updates its button back to Fullscreen. The embedded App only uses host display
modes; it never tries to escape the host's iframe with browser fullscreen.

The browser listener binds only to `127.0.0.1` on an OS-assigned port, starts only
after `rea_workbench` receives `open_browser=true`, and stops with the MCP
connection. Its single-use opaque handoff is in the URL fragment, exchanged for
an HttpOnly SameSite=Strict cookie; private form data and provider credentials
never appear in that URL. Exact Host/Origin validation, a 1 KiB ticket-claim
bound, an 8 MiB authenticated tool-request bound and a narrow operation
allowlist protect the live connection. At most two browser tool requests run
at once; pending handoffs share a 16 MiB serialized-byte budget. It serves only the
built workbench and its session endpoints. The App's hosted resource still
requires no direct network permissions.

## Local analysis and explicit cloud opt-in

Analysis providers and artifact inspection continue to run locally. The optional
reasoning engine sends the assignment and selected Evidence to OpenRouter.
It is disabled unless all three required variables are present:

| Server environment variable | Meaning                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `REA_AI_ENABLED`            | Exactly `true` enables cloud reasoning.                       |
| `OPENROUTER_API_KEY`        | Server-side OpenRouter credential. Never supplied to the App. |
| `REA_AI_ANALYST_MODEL`      | Your selected analyst model ID. No default.                   |
| `REA_AI_REVIEWER_MODEL`     | Optional reviewer model ID. No default.                       |

Set these in the MCP host's server environment or in the launching shell. REA does
not automatically load a `.env` file. Restart the server after changing them.
Keep credentials outside committed configuration and use the host's credential
storage where available. An existing stdio entrypoint still works, for example
`node C:/Users/Admin/Downloads/rea-main/scripts/rea.mjs mcp` after building locally.
Use absolute paths appropriate to your installation; preserve unrelated host
configuration entries.

Chosen models must support the configured JSON output format; the analyst also needs
function calling. Requests require supported parameters, ZDR endpoints and
`data_collection=deny`, with automatic provider fallback disabled. A model with
no matching endpoint fails explicitly. These routing requests do not establish
an independently verified retention policy. The same model may fill both roles
if you explicitly configure both IDs.

## Delegation and main-agent handoff

The main host agent owns the user's investigation. REA's coordinator gives a
scoped assignment to an analyst and then, when requested, an independent reviewer.
The analyst can inspect assigned retained analysis views. Native function
analysis requires `allow_function_analysis=true` and an active target. The
reviewer receives the sources and analyst report and has no tool authority.
Neither worker can open, switch or close targets, execute shell commands, mutate
executable bytes, or save/close an attached IDA GUI database.

1. Collect Evidence using existing REA workflows, or import a canonical bundle.
2. Call `start_investigation` with a question and explicit sources:

   ```json
   {
     "question": "Explain this observation and identify unsupported assumptions",
     "sources": [
       {
         "kind": "retained-evidence",
         "evidence_id": "COPY_RETURNED_EVIDENCE_ID"
       }
     ],
     "review": false,
     "allow_function_analysis": false,
     "budget": {
       "max_requests": 8,
       "max_output_tokens": 2048,
       "max_context_bytes": 262144,
       "max_response_bytes": 1048576,
       "timeout_ms": 120000
     }
   }
   ```

3. The start response is a compact acknowledgment containing `run_id`, `state`
   and `phase`. Call `read_investigation` with that ID until terminal. Reports
   include findings, exact Evidence citations, assumptions, unresolved questions,
   activity and per-request model/usage metadata. Missing cost or token usage is
   reported as `null`, never as zero.
4. Reads omit source bodies by default and report `total_sources`. To retrieve
   complete Evidence, pass `include_sources=true`, `source_offset=0` and
   `source_limit=1`, then follow `next_source_offset` until null. A single source
   too large for MCP delivery needs a larger `REA_MCP_MAX_RESPONSE_BYTES` with a
   matching client buffer, or its existing Evidence bundle export workflow.
   Source records are never silently truncated.
5. `cancel_investigation` requests cancellation. Read until terminal; admission
   and provider ownership remain held until underlying work settles.

The App can start/read/cancel assignments, inspect Evidence and focused code
views, browse explicit provenance links and retained comparison results, load
the Unknown ledger, import/export local bundles, and export complete worker
reports. Its **Discuss with main agent** action sends a user message containing
the run ID through the host bridge. Host support and user interaction are
required; workers do not promise unsolicited messages to arbitrary hosts.
Comparison requests are handed to the main agent's existing comparison tools.

The **Features** view saves a selected behavior, exact target bindings, existing
reconstruction obligations, scenario inputs and Evidence in a revisioned local
project. It displays finite claim results separately from feature readiness;
the canonical obligation ledger remains the closure authority. See
[feature workspaces](feature-workspaces.md) for the public CLI/MCP workflow,
restart behavior and portable handoff.

Assignments may select `planner`, `static-analyst` and `behavior-analyst` in
`specialists`. Independent specialists run concurrently over identical immutable
starting Evidence, using the configured analyst model and one shared deadline/request budget.
Their reports are ordered by the selected roles for analyst synthesis, followed
by review. Provider operations remain serialized, and identical concurrent probes
share one owned request. Planner and behavior analyst inspect assigned
retained views; only static analyst and analyst can use explicitly admitted
native function analysis. The reviewer has no tool authority. There are no
per-role default models and specialist mode has not yet demonstrated a measured
performance improvement.

For one-shot CLI use, `rea investigate input.json` accepts the same assignment
with portable `inline-evidence` sources. It waits for the report, prints complete
JSON and exits unsuccessfully for failed, limited or cancelled runs. CLI workers
cannot acquire an active target for native function analysis.

## Budgets, provenance and lifetime

Request budgets count attempted model requests, including failed/cancelled
requests. One request is reserved for each remaining role. The context
byte budget is checked before materializing a model input; oversized selected
Evidence returns `limited` with no silent truncation. Output-token exhaustion,
response byte exhaustion and deadlines also produce `limited`. These states
preserve partial reports and observations without claiming completeness.
Request/token budgets alone are not a dollar cap. For conservative server-wide
spending admission, set both `REA_AI_SPEND_LIMIT_USD` and an absolute
`REA_AI_SPEND_LEDGER` SQLite path. Reservations commit before inference and remain
charged against admission after cancellation, crashes or failed responses.
Each reserves advertised endpoint context/output capacities with framing and
pricing headroom; request byte/output bounds and provider rate ceilings are
enforced before dispatch. Empty or unknown pricing fails closed. Reported billing
above a reservation stops further admission while later owned receipts remain
recordable. This guard depends on truthful endpoint limits/rates and provider
enforcement; it is not an independent upstream account billing cap. Use an
OpenRouter key budget for an additional upstream limit. BYOK estimates and
unrelated use of the same key require separate accounting.

`REA_AI_ANALYST_REPORT_FORMAT` and `REA_AI_REVIEWER_REPORT_FORMAT` accept
`json-schema` (default) or explicit `json-object` conditioning. Both require the
same strict local report schema, including every finding's assumptions and exact
Evidence citations; missing fields are failures, never filled implicitly.
There is no automatic format or model fallback. Valid upstream usage is retained
even when a returned report is rejected. Batch model variants require a separate
asynchronous retention/ownership contract and are unsuitable for this synchronous
engine. Choose a synchronous model explicitly.

REA does not automatically discover `.env`. Load a caller-selected file through
the Node launcher, for example `node --env-file=/absolute/path/.env
/absolute/path/rea/scripts/rea.mjs mcp`, or supply the same variables in the host's
server configuration. Credentials remain server-side; `.env` is excluded from Git
and package files. No model IDs are supplied by the runtime.

Only values explicitly supplied in `sensitive_values` are redacted from model
input, including escaped string values. Local Evidence remains intact. No
secrecy is guessed from field names or patterns. Artifact content and previous
model reports are treated as untrusted data. Each generation records the digest
of its bounded, redacted context and the exact source Evidence IDs. Cloud HTTP
error payloads and transport credentials are excluded from diagnostics.

Canonical source digests are authenticated and records sealed. Worker findings
are always `inferred`, kept separate from observed/derived Evidence. Citations
outside the assigned source set are rejected; valid citations alone do not
prove that a claim follows from the evidence. Reviewer agreement does not
establish truth.

Runs belong to one MCP connection and remain in memory until it closes. They
retain their assigned Evidence even if the session's current target or ledger
later changes. A live native investigation holds session admission for its
entire lifetime, preventing target replacement during worker awaits. Closing
the connection aborts and drains workers before provider cleanup. Export reports
and Evidence bundles for a portable handoff. Supplying `feature` with a project
ID and current expected revision additionally persists worker checkpoints into
that project. These jobs use a per-run SQLite ownership lease; when the owner is
lost, reading the current project marks its unfinished job `interrupted` without
replay. Historical revisions retain their original state. Live target sessions
and connection-local `read_investigation` IDs are not restored. The ambient
environment and provider credentials are never persisted.

## Build and verification scope

Use the pinned Node/npm toolchain, `npm ci`, then `npm run build:cached`. The build
bundles `ui/workbench.html` into one self-contained `dist/ui/workbench.html`;
resource loading is relative to the package, independent of the process's cwd.
App network and remote-resource CSP domains are empty. Cloud requests happen in
the server adapter.

Coordinator tests, mock OpenRouter HTTP tests and MCP boundary tests establish
local scope, budgets, cancellation, schemas and report delivery. The browser
fixture exercises the production App bridge with explicitly simulated model
responses. These checks do not establish live paid-provider quality/billing,
installed Codex/Claude/ChatGPT host acceptance or native Ghidra/IDA/Hopper behavior.
