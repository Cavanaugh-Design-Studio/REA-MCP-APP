# Durable feature workspaces

A feature project connects a selected behavior to existing reconstruction
obligations, scenario inputs, canonical Evidence and a candidate target. It is
usable through the App, CLI and MCP with cloud reasoning disabled. Creating a
project or exporting a brief does not establish that an implementation works.

## Storage and revisions

`REA_PROJECT_STORE` selects an absolute SQLite path. The default is
`~/.rea/feature-projects.sqlite`. Construction is lazy; the first project
operation creates the local store. SQLite transactions append immutable,
digest-linked revisions. Read authenticates the complete predecessor chain and
canonical Evidence. A stale expected revision fails rather than overwriting a
concurrent update. Back up the database using SQLite's backup facilities or
after every owning server has closed; an active WAL is part of its state.

Targets, ordinary scenario inputs and local Evidence remain caller selected.
Browser secrets use existing environment-variable references; their values are
not stored in cases. Durable process cases reject explicitly sensitive input
bytes. Run those secret-bearing scenarios outside the persisted case definition
and retain their redacted Evidence. Ambient environment and provider credentials
are not saved. Failed cleanup retains ownership for retry.

## Public workflow

| MCP tool                            | CLI command                         | Outcome                                          |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `create_feature_project`            | `create-feature-project`            | Revision 1 of a complete definition              |
| `read_feature_project`              | `read-feature-project`              | Current or exact historical inspection           |
| `list_feature_projects`             | `list-feature-projects`             | Saved project identities and current revisions   |
| `revise_feature_project`            | `revise-feature-project`            | Append at `expected_revision`                    |
| `export_feature_handoff`            | `export-feature-handoff`            | Exact revision into an absent absolute directory |
| `compare_browser_scenario_evidence` | `compare-browser-scenario-evidence` | Derived comparison of two authenticated captures |

Each CLI command accepts an input JSON object or file path and supports `--json`.
For example, after building:

```powershell
node scripts/rea.mjs list-feature-projects '{}' --json
node scripts/rea.mjs create-feature-project feature-definition.json --json
node scripts/rea.mjs read-feature-project read-feature.json --json
```

The minimal definition is:

```json
{
  "title": "Annotation persistence",
  "goal": "Retain semantic annotation coordinates after save and reopen",
  "original": {
    "kind": "browser",
    "location": "http://127.0.0.1:4100/",
    "sha256": null
  },
  "candidate": {
    "kind": "workspace",
    "location": "C:/analysis/candidate",
    "sha256": null
  },
  "evidence_bundle": {
    "artifacts": [],
    "providers": [],
    "environments": [],
    "scenarios": [],
    "captures": [],
    "unknowns": [],
    "records": []
  },
  "obligations": {
    "reviewed_obligations": [],
    "manifest": { "bindings": [], "contradictions": [] }
  },
  "specification": null,
  "cases": [],
  "notes": []
}
```

This empty initial project has unknown readiness. Attach an actual bundle object,
including its canonical manifest, as observations become available. Use the existing
[obligation ledger](reconstruction-obligation-ledgers.md) to review requirements
and bind original authority, implementation owners, case fixtures and verifiers.
Each case selects existing browser/process scenario inputs for both sides,
reviewed `obligation_ids` and finite specification `claim_ids`.

Run the selected scenarios with `capture_browser_scenario` or
`capture_process_scenario`; comparisons do not execute targets. Browser claims
use `kind: "browser-behavior"`, `dimension: "overall"` and a
`comparison_evidence_id`. Different browser origins require explicit
`origin_pair` values. These permit context alignment only: observed URL values
still need caller-declared literal normalization if they should compare equal.
Changing viewport, locale or other replay settings withholds equality. Requested
artifacts cannot be relabeled unrequested to obtain a pass.

Feature proof additionally binds each claim to exactly one case and the observed
target identity. Browser target URLs must exactly match the committed start URL;
structured query additions and artifact digests remain unsupported bindings.
Process targets require the exact executable path and launch-associated digest
from the capture manifest, plus the full committed scenario. A workspace path
alone is an implementation destination, not runtime identity. Set a runtime
candidate binding before asking for current feature proof.

Old results remain inspectable as `historical_verification`; changed targets,
cases, specifications, obligations or implementation/fixture/verifier bindings
cannot silently reuse them. New comparisons and a new
revision are needed for current proof. `verification` describes finite claims;
`readiness` additionally requires the canonical obligation ledger to be ready.
Known contradictions fail readiness. Missing authority, unbound requirements
and untested cases remain unknown.

## Durable investigations

`start_investigation` may include
`feature: { "project_id": "RETURNED_UUID", "expected_revision": 1 }`.
Assigned sources must already belong to that feature's Evidence bundle. Optional
`specialists` share the configured analyst model and total request/deadline
budgets; minimum requests must cover each selected role, analyst and requested
reviewer. No default model is supplied. See [engine setup](mcp-app.md).

Checkpoints retain reports, inferred findings, citations, usage and events in
new project revisions. Each run holds its own SQLite lock lease until its work
settles. If the owner disappears or terminal persistence fails, reading the
current project marks a retained running checkpoint interrupted. It never
replays a target operation or restores a live provider session. Read the saved
project for durable history; `read_investigation` remains connection local.

## Portable handoff

`export_feature_handoff` writes `feature-spec.md`, `feature-manifest.json`,
`evidence.json`, `proofs.json`, `ledger-input.json`, `obligation-ledger.json`, `implementation-brief.md`, declared
`cases/`, `verification.json` and `report.html`. Every file has a byte count and
SHA-256 in `handoff-receipt.json`, which is written last. The destination must
not exist. Failure retains a partial directory and returns an error; absence of
a complete receipt must never be interpreted as successful delivery.

Finite browser proof requires an explicit case kind and an unambiguous binding
from original capture, candidate fixture, comparison and claim to the exact
reviewed obligation version. Use `rea:browser-scenario-equality` as the named
deterministic renderer verifier descriptor. It does not execute an arbitrary
command. Inspection derives proof from the full canonical source closure;
public ledger evaluation independently recomputes it and checks the current
owner/parser/verifier bindings. Declared passed arrays are insufficient.
Renderer proof stays derived and cannot satisfy packaged-process, native ABI,
protocol, external or live-observation requirements. `ledger-input.json` carries
the exact effective bindings and Evidence needed to reproduce the exported
ledger; the feature manifest retains the original caller declarations.

An optional `implementation` contains exact UTF-8 files with relative `path`,
`sha256` and `content`, plus `launch_instructions`. File digests are validated
before persistence; portable ownership rejects traversal, aliases and duplicate
paths. Export delivers these bytes under `candidate/` and adds `run-candidate.md`.
The server never executes launch instructions. Delivered files and owner paths
are declarations until their execution/identity is established by the relevant
scenario/provider. Changing implementation bytes invalidates current feature
proof; old results remain historical.
Revision proof refresh requires a newly captured candidate source for every
replacement comparison. All prior source identities remain known through the
authenticated revision chain, including records removed from the current
manifest. Relabeling a normalization rule or removing and restoring an old
capture cannot refresh stale proof. Unknown, unsupported and skipped verifier
results remain incomplete; only an actual failed verifier result marks failure.

The App supports creating/opening projects, inspecting readiness, preparing a
scoped investigation, reviewing saved jobs, editing the exact definition,
main-agent build/repair handoff and export. The case editor selects retained
browser captures, requires explicit normalization, and saves their comparison
as a finite case. Timelines, per-step differences and original/candidate
observations remain inspectable together. New runtime capture is requested
through the main agent's existing explicitly scoped capture tools. Attaching
session Evidence merges it with earlier project records and unknown histories.
The standalone fullscreen view exposes local project operations and comparison;
filesystem export and main-agent messaging stay in the original host App.
Fullscreen reopens the exact saved project revision. Its one-time ticket carries
the selected case and unsaved manifest text edit rather than duplicating the
saved definition and Evidence. Concurrent changes remain subject to the same
revision check when saving. An unsaved edit that itself exceeds the handoff
8 MiB serialized handoff budget still fails explicitly without discarding the
original editor state. Pending tickets share a 16 MiB serialized-byte budget.
The browser accepts at most two authenticated tool requests at once, each with
an 8 MiB request-body limit; ticket-claim requests remain limited to 1 KiB.
These limits bound input bytes, not total JavaScript heap or response size.

## Reproduce the browser demonstrator

After building, run the public CLI/MCP exercise against an installed Chromium
browser. No browser or inference provider is downloaded or enabled by this script:

```powershell
node scripts/verify-feature-workspace.mjs "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

It retains independent reference/candidate captures, seeds a zoom bug, compares
seven finite cases, executes the repaired candidate, detects a changed reference
version, exports a handoff and reopens the project through CLI. The report keeps
timings and unsuccessful attempts. This transparent fixture was built by the
same implementation agent and is not a blind reconstruction or agent benchmark.

The demonstrator now derives canonical renderer proof from its complete source
closure and reproduces a ready ledger from the exported `ledger-input.json`.
This readiness applies to the declared finite renderer obligations. Capture
Evidence and comparisons retain their original confidence; the derived proof
does not establish packaged/native authority or arbitrary application equivalence.
Real Windows Electron cleanup, the managed study and a 30-trial live comparison
are recorded in the [final acceptance report](feature-benchmark.md). Their finite
scope and unsuccessful attempts remain explicit. Installed Codex App acceptance
was removed from final scope; general specialist efficiency is not established.

For a real managed-artifact study, use a caller-installed .NET 9 SDK:

```powershell
node scripts/verify-managed-feature.mjs
```

This builds an isolated source-owned pricing DLL, inspects its artifact, members
and native-boundary declarations through public MCP, repeats artifact inspection
through CLI, and executes eight original/candidate cases. It detects a seeded
shipping bug, checks malformed/negative/overflow inputs and verifies that
inspection preserved executable bytes. Generated source, binaries, observations
and the report stay under the returned local cache directory. This establishes
finite execution comparison and real managed inspection; it supplies no blind
reconstruction benchmark, decompiler oracle or native ABI certificate.
