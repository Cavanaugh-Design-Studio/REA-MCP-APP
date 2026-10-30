# Internal research and reconstruction planning

These capabilities belong to REA's investigation agents. The client submits
work through the existing four model-facing MCP tools. There are still 15
registered MCP tools, including the 11 App-only workspace operations. Neither
research capability is registered as a separate public MCP tool.

Ordinary executing agents receive 12 internal tools: four workspace primitives,
seven semantic analysis operations, and the reconstruction planner. Explicitly
enabling web search adds a thirteenth. Feature assignments retain their scoped
project operations. Reviewers receive no execution tools. The actual authored
13-tool internal catalog measures 11,369 serialized bytes; tests bound it below
16 KiB and independently count the public advertised catalog.

## Brave Search

Configure `BRAVE_SEARCH_API_KEY` in the server environment or the private env
file explicitly selected at launch. Restart/reconnect the server. The workbench
does not save the key. Credentials are sent only in the server's HTTPS request
header and remain excluded from analysis child environments and telemetry.

Check **Allow public Brave searches (up to 3)** on the investigation form, or
submit an assignment such as:

```json
{
  "question": "Inspect the selected feature, research public API documentation, and propose a reconstruction plan with observable cases",
  "target": "C:/analysis/original-app",
  "workspace": "C:/analysis/results",
  "allow_web_search": true,
  "max_web_searches": 3,
  "specialists": ["planner"],
  "review": false
}
```

The internal `search_web` contract accepts `query`, optional `count` (1–10,
default 5), page `offset` (0–9), and `freshness` (`pd`, `pw`, `pm`, `py`). The
query is limited to 600 characters and 75 words. Only the query and those
controls go to Brave, not the full investigation context. Do not include
private source, target contents, or sensitive information in a public query.
Queries containing literal caller-selected sensitive values or known configured
credential values are rejected before dispatch; this is not general-purpose
data-loss prevention.

The run allowance defaults to three queries, can be explicitly selected from
1–20, and counts dispatched attempts, including failed requests. There are no
automatic retries. Requests use a fixed HTTPS Brave endpoint, reject redirects,
share investigation cancellation, and have a 15-second timeout. Response bodies
are bounded by the lower of 256 KiB and the caller's context byte budget. No
result pages are automatically fetched. Missing credentials, rejected input,
rate limits, malformed/oversized responses and transport failures remain
explicit failures, not empty search results or proof of absence.

Successful responses become canonical `external-service` Evidence with exact
raw response text, query, URLs, snippets, and request/retrieval timestamps.
Search content is untrusted reference material. An observed service response
does not establish the truth of its snippets, page publication dates, target
behavior or completeness. Live provider access requires a caller-supplied key;
development tests use an injected fixture transport and incur no Brave charges.

API contract: [Brave Web Search](https://api-dashboard.search.brave.com/api-reference/web/search/get).

## Reconstruction blueprints

The model authors the plan. `plan_reconstruction` validates and retains its
structure without making another hidden model call. Its named contract covers:

- `scope` (`feature` or `application`) and `goal`.
- `features`: stable ID, expected behavior, assigned Evidence IDs, assumptions.
- `components`: responsibilities, supported feature IDs, interfaces and state.
- `cases`: feature IDs, positive/negative/malformed/cancellation/teardown kind,
  exact input description, and observable expected result.
- `steps`: action, component/feature/case IDs, and prerequisite step IDs.
- `unknowns`: unresolved coverage and design questions.

The planner rejects unassigned Evidence IDs, duplicate identities, dangling
references, dependency cycles, uncovered features/components, or steps whose
features have no matching component or case. It produces a deterministic
implementation order. Plans are bounded to 30 features, 20 components, 60
cases and 40 steps and to the lower of 128 KiB and the caller's context budget;
larger applications can be divided into phase plans. Model request/output
budgets still apply, so size them explicitly for the assigned scope.

The result is an authenticated Evidence record with `confidence: inferred`,
`authority: analyst-inference`, `verified: false`, explicit source links, and
every proposed case marked `not-executed`. Existing run persistence saves it
under the owned workspace's `evidence/<Evidence-ID>.json`; existing Evidence
export and inspection also retain it. Structural validation does not validate
the meaning or completeness of model claims. There is no automatic promotion
to a canonical feature specification or a verified project state.

The resulting workflow is investigation → public research when enabled →
proposed architecture → workspace implementation → executed original/candidate
checks. Existing `write_file` and `run_command` can build and check candidates
when assigned; feature-bound runs can use their existing project revision,
Evidence attachment and deterministic comparison contracts. Original paths,
canonical proof, process ownership, failed cleanup and cancellation semantics
remain authoritative. A full application requires its own scoped requirements,
implementation and acceptance; these tools do not guarantee universal cloning
or equivalence.

Validation includes a fixture agent that reads an original module, searches via
the injected Brave transport, records a blueprint, writes a candidate module,
and runs an owned-process comparison on four explicit input cases. This proves
the connected workflow and finite fixture behavior, not live-model planning
quality, real Brave acceptance, or full-application parity.
