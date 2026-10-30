# REA MCP App

An investigation workbench whose **internal agents do the analysis**. The client submits a question and target, follows progress, and receives Evidence-backed findings. Internal agents use [leanrea](leanrea/SKILL.md) to select and execute installed local tools.

This app carries over the workbench and canonical Evidence/project semantics.
Selected static parsers, graph builders and owned engine protocols now run
internally. The original 180-tool catalog and registration remain excluded.
There is no `rea-agents` runtime dependency or hidden MCP server.

Internal agents can now generate JS/Electron AST and relationship graphs,
decode .NET metadata/CIL/native declarations without executing target code,
project managed graphs, inspect native functions through caller-installed
Ghidra, execute owned browser scenarios, and acquire selected-device PNG/XML,
logs and properties through caller-installed adb. The workbench pages managed
code and displays graph relationships with their evidence basis. See
[implementation and acceptance](docs/capability-implementation.md).

The catalog has **4 model-facing tools and 11 App-only workspace operations**: 15 registered tools total. Hosts that ignore MCP Apps visibility may display all 15. Current measured definitions: 4,917 bytes for model-facing tools; 9,528 bytes for the complete catalog. Re-run acceptance after contract changes.

| Client tool            | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `rea_workbench`        | Open the UI; inspect configuration and runs   |
| `start_investigation`  | Assign work to internal execution agents      |
| `read_investigation`   | Read progress, reports and paginated Evidence |
| `cancel_investigation` | Cancel and drain owned commands               |

App-only operations retain Evidence import/export, focused views, Unknowns, feature revisions, canonical comparisons and handoff export. Ordinary internal investigations use command execution, focused file reads, file writes and directory inspection. Feature assignments additionally receive scoped project editing/comparison operations.

## Setup

Replacing an earlier checkout or MCP registration? Read the
[repository migration guide](docs/repository-migration.md) first. The old source
remains in Git history; the launch commands and public catalog have changed.

Internal agents can also use `plan_reconstruction` to retain an Evidence-linked
feature or application blueprint, then implement candidates with the existing
workspace tools and test selected behavior against the original. A plan remains
inferred; its creation does not pass a reconstruction or parity gate.

Optional `search_web` uses Brave Search with server-side
`BRAVE_SEARCH_API_KEY`. Enable **Allow public Brave searches** for an assignment
in the workbench, or pass `allow_web_search: true` to `start_investigation`.
Search is off by default, with a default allowance of three requests per run.
See [research and reconstruction planning](docs/research-and-planning.md).

Use Node from `.nvmrc` and npm from `package.json#packageManager`:

```sh
npm ci
npm run build
npm test
```

Analysis utilities are bring-your-own: for example rg, Go, LLVM tools, Ghidra, JADX, Apktool, ILSpy or browser tooling. REA does not install or upgrade them or unrelated runtimes. Internal agents must adapt the guide's Unix recipes to the reported platform. The upstream leanrea benchmark was macOS-only.

Configure server-side `REA_AI_ENABLED=true`, `OPENROUTER_API_KEY` and `REA_AI_ANALYST_MODEL`. There are no production model defaults. A reviewer is optional and runs only when requested. `.env.example` documents settings. Environment files are loaded only when explicitly selected by Node.

The package includes `leanrea/SKILL.md` and injects it into internal model
requests automatically; installing a separate skill is unnecessary. The same
unaltered bundled guide is available as the read-only MCP resource
`rea://internal/skills/leanrea`, including upstream attribution and benchmark
limits. Reading the resource does not execute its recipes or install utilities.

Optional OpenTelemetry tracing and metrics are enabled server-side with
`REA_OTEL_ENABLED=true` and an explicit `REA_OTEL_ENDPOINT` collector base URL
(for example `http://127.0.0.1:4318`). REA installs no collector and adds no MCP
tools. See [telemetry configuration and privacy](docs/observability.md).

On Windows x64, command ownership uses the package-owned `native/windows/build` Job Object addon. The existing verified REA 6.3.0 component was staged there for local verification; build output is ignored by Git and included explicitly in package artifacts. Its manifest/hash/ABI checks and cleanup are retained. `REA_WINDOWS_NATIVE_DIR` can select a different matching directory. Native sources and the Linux/MinGW cross-build lane are included; that cross-build has not been rerun during this port. No secrets were copied.

## MCP registration

Build first. Use the local launcher; **upstream `npx rea-agents` does not launch this app**:

```json
{
  "mcpServers": {
    "rea-mcp-app": {
      "command": "node",
      "args": [
        "--env-file=C:/analysis/rea-mcp-app.env",
        "C:/analysis/REA-MCP-APP/scripts/launch.mjs"
      ]
    }
  }
}
```

Adjust paths. Keep credentials in host secret storage or the selected private file. Restart/reconnect after changes. MCP Apps hosts render `ui://rea/workbench.html`; other clients receive JSON reports. Fullscreen can continue the same connection through an authenticated loopback browser view. No public server or tunnel is required.

Example assignment:

```json
{
  "question": "Trace the search IPC channel and show its supporting source",
  "target": "C:/analysis/selected-app",
  "workspace": "C:/analysis/results",
  "review": false
}
```

REA creates a fresh run directory, copies the selected local target, gives its working path to internal agents, executes their local tool requests, and retains observations and reports. The client only starts/reads/cancels. Commands use the launching user's permissions: process ownership and workspace-scoped file tooling are **not an OS sandbox**.

Local Evidence remains intact. Explicit `sensitive_values` are redacted from model context. Model credentials are excluded from child environments. Findings remain inferred; deterministic verification owns finite pass/fail/unknown results. Request/token budgets are not dollar caps; optional spending admission and upstream key limits are separate.

## Migration and verification

[Preservation map](docs/migration-plan.md) · [retained source manifest](docs/retained-source-manifest.json)

Broad target coverage is tracked in the [capability parity assessment](docs/capability-parity.md)
and its [machine-readable requirements](docs/capability-parity.json). The internal
guide includes routes for all 15 original target families; a route is not proof
that its utilities are available or its results match the original.

After building, use the pinned Node/npm to run `npm run verify:parity`. It reads
the sibling `../rea-main` checkout by default; select another existing checkout
with `npm run verify:parity -- --original C:/analysis/rea-main`. This runs three
finite, scripted internal assignments, compares actual original CLI results,
measures stdio discovery and offline package payloads, and retains full reports
under `.cache/parity-*`. No inference, install, or original source edit occurs.
It needs the original's existing build and installed ASAR utility. This optional
acceptance dependency is not part of the shipped application.

`npm run verify:parity:strict` performs those checks and exits unsuccessfully
while full target/model parity remains unverified. Passing the bounded checks
alone must never be described as equal power. Package bytes exclude installed
dependencies and external analysis tools; timings compare different amounts of
work and are not a model-efficiency benchmark.

Existing feature formats and SQLite revisions are retained. The separate default store is `~/.rea-mcp-app/feature-projects.sqlite`. Back up an existing database before explicitly selecting it. Runs never replay automatically after restart.

`npm test` exercises the MCP boundary, simulated model decisions, real owned command execution, cancellation/descendants, partial output, scoped file failures, project revisions and export receipts. This does not establish paid-model quality, every provider, universal capability parity or installed-host visual acceptance. Matching task comparisons are required for efficiency claims.

After building, `npm run preview` starts a local UI fixture with simulated decisions and the real runtime. It makes no inference-provider calls. If a Windows build lacks its packaged native artifact, select a matching native directory as described above.

The original [leanrea README](docs/leanrea-upstream-readme.md) and `bench/` remain upstream evidence, not benchmarks of this new app. leanrea is credited to aicodeking. Retained REA code is credited to morluto and contributors under [their MIT license](third_party/rea.LICENSE).
