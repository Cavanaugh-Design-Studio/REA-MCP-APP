# Final acceptance and comparative benchmark

Recorded 2026-10-11. This delivery closes the requested Windows Electron cleanup
integration and comparative benchmark. Installed Codex embedded-App acceptance
was explicitly removed from scope. No runtime model defaults were introduced.

## Delivered and verified

- Color-coded light/dark MCP App, portable fullscreen and durable feature projects.
- Revisioned Evidence, stale/tampered proof rejection, finite source-backed
  verification and runnable source export.
- Configurable OpenRouter analyst/reviewer and scoped specialists with shared
  budgets, cancellation, retained reports and main-agent handoff.
- Real Chrome demonstration: 22 captures, seven repaired cases, seeded bug and
  version-change detection, and reproduced exported proof closure.
- Real .NET 9 managed study: eight passing comparison cases, three seeded
  failures detected, public CLI/MCP inspection and unchanged DLL bytes.
- Real Windows Electron public MCP capture: five actions completed, IPC echo,
  two windows and verified `terminated-owned-process` cleanup.

The source-owned studies prove their declared finite behaviors. They do not prove
arbitrary application equivalence, blind binary reconstruction or native ABI
compatibility.

## Windows Electron cleanup

Windows launches an isolated worker through the existing native owned-process
boundary. The worker is atomically assigned to a retained, non-breakaway Job
Object before launching Electron. The parent terminates and verifies the job,
including descendants, before returning successful cleanup. Failed cleanup
retains its owner and blocks a new capture until retry succeeds. Worker replies
are validated and bounded; partial observations and failure reasons survive.
Windows environment allowlisting handles case-insensitive names such as `Path`
and `ComSpec`. Credentials are not passed to the target. Sampled PID lists are
not used as Windows termination authority.

The matching Windows native addon is required. This checkout used the official
`rea-agents@6.3.0` artifact after registry-integrity and manifest-hash verification.
The Electron runtime was separately verified against its official archive hash.
No provider or unrelated toolchain was installed by setup.

After `npm run build:cached`, check detached-helper, cancellation and failed
startup cleanup with a caller-supplied Electron executable:

```powershell
node scripts/verify-electron-cleanup.mjs "C:/path/to/electron.exe"
```

This verifier uses the production provider boundary. The successful normal public
MCP capture is retained separately under
`.cache/electron-acceptance/1791736460260/report.json`.

The final real cleanup verifier passed all three cases: a detached five-minute
helper, cancellation with retained partial capture, and failed startup. Its
report is `.cache/electron-cleanup/1791737877811/report.json`. Graceful transport
close timeouts are retained as limitations; the parent native job owns and
verifies final termination. The final build, root typecheck and ten focused
Electron tests passed; touched-file lint returned no errors (complexity warnings
remain).

## Live comparison

All 30 trials used the same explicit main model, `google/gemini-3.8-flash`.
Specialist attempts used `apodex/apodex-1.1-mini:free`; the reviewer was disabled
for this comparison. Each arm ran five times in each of two lanes: a 45-second
deadline and a $0.60 per-request ceiling with a 90-second deadline. Each trial
allowed one candidate generation, with no repair feedback. A durable $20 total
local admission ledger covered the existing benchmark campaign.

Every main model received the same task contract and three visible observations.
The evaluator used real Chrome to produce 20 expected coordinate-transform
results; 17 held-out cases and the reference source never entered model prompts.
Order was randomized with a recorded seed, conversations/workspaces were fresh,
and trials ran sequentially. Local cache conditions were recorded; provider
caching remains unknown. This is a blind finite coding harness, not an installed
IDE/tool-use benchmark. The specialist's retained Evidence came from the earlier
source-owned demonstration; it does not prove identity with the repaired target.

| Lane         | Arm                                   | Fully passing trials | Verified cases | Median elapsed, all trials | Known cost |
| ------------ | ------------------------------------- | -------------------- | -------------- | -------------------------- | ---------- |
| Fixed time   | A: observation transcript             | 1/5                  | 64/100         | 8.75 s                     | $0.008025  |
| Fixed time   | B: REA Evidence                       | 2/5                  | 73/100         | 5.42 s                     | $0.008156  |
| Fixed time   | C: feature brief + specialist attempt | 2/5                  | 73/100         | 11.60 s                    | $0.008865  |
| Fixed budget | A: observation transcript             | 0/5                  | 44/100         | 3.99 s                     | $0.010410  |
| Fixed budget | B: REA Evidence                       | 3/5                  | 71/100         | 3.76 s                     | $0.010875  |
| Fixed budget | C: feature brief + specialist attempt | 3/5                  | 82/100         | 9.13 s                     | $0.008190  |

Total observed cost for this completed run: **$0.05452125**, including all
reported worker calls. Both malformed main responses remain unfinished and their
costs are included. Incorrect candidates remain incorrect. Reports retain token
usage, provider/model identities, timings, held-out results and each candidate.
Unsupported factual claims were not independently scored and remain unknown.

All ten specialist reports were limited by the 512-token report budget; none
produced a complete report. Arm C therefore measures the configured bounded
specialist attempt and fallback path, not successful collaborative reasoning.
It matched B's completion count but took more than twice its median time in
both lanes. The preregistered 20% time-improvement target was not met.
Keep specialists optional; this run supports no general superiority claim.
Five trials per arm per lane are exploratory and do not establish statistical
significance or causation.

## Retained evidence and reproduction

The completed comparison is at
`.cache/feature-benchmark/1791737358351/report.json`, with per-trial prompts,
worker responses, candidates, evaluations and preregistration. Earlier routing
failures and interrupted pilots remain under `.cache/feature-benchmark`; they
are excluded from the completed-run table and remain part of the spending
ledger. Unknown billing receipts retain their admission reservation. A single
$0.000006 routing diagnostic omitted pre-dispatch local admission; it was
recorded afterward in `.cache/benchmark-preflight-observation.json`. It did not
satisfy the pre-dispatch guard.

To run another comparison, use a private server env file and choose the main
model explicitly. This performs real billable requests and reuses the existing
ledger; it never resets spending to obtain more admission capacity:

```powershell
$env:REA_BENCH_MAIN_MODEL = "google/gemini-3.8-flash"
node --env-file=.env scripts/verify-feature-benchmark.mjs
```

The default fixture/Evidence paths refer to this checkout's retained demonstration.
Supply an exported candidate directory and matching Evidence file as positional
arguments when using a different checkout. Installed Chrome, the built runtime,
the matching native addon and local fixture artifacts are prerequisites. No API
key belongs in prompts, App state, reports or committed files.

Browser and managed reports are at
`.cache/annotation-demo/1791734528914/verification-report.json` and
`.cache/managed-feature/1791734685448/report.json`. Existing installed-package
acceptance is at `.cache/packed-acceptance/1791735825040/report.json`; that report
predates the Electron integration and does not prove the final integration was
installed into an MCP host. See [App setup](mcp-app.md) and
[feature workflows](feature-workspaces.md) for configuration and use.
