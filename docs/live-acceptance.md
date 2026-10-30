# Bounded acceptance: 2026-10-27

| Check | Result | Scope |
| --- | --- | --- |
| Live-model quality | Blocked | Existing $20 spending ceiling retained at the user's direction. |
| Real analysis tooling | Partial | One real Electron ASAR extraction comparison passed. Broader provider parity remains unverified. |
| Fresh installed-host visuals | Passed, bounded | Claude Desktop 3.1623.4: embedded rendering, dark/light themes, Evidence navigation, fullscreen entry and exit. |

## Live-model gate

The existing ledger had $19.699968853 reserved against its $20 admission ceiling.
The configured `z-ai/glm-5.3-flash` model required a conservative $1.50525144
reservation per request. Known recorded actual cost ($0.0644175) is distinct
from reservations and does not free admission capacity under the current policy.
The user chose to keep the ceiling and report this check blocked.
No REA/OpenRouter inference requests were made; the ledger, ceiling and model
configuration were not changed. Task quality, agent tool selection and reviewer
quality therefore remain unverified with live models.

## One real archive comparison

Ran the new runtime's production `LocalTools.prepare` and `run_command` path
against a source-owned Electron ASAR, using already-installed `@electron/asar`
4.2.0. No model selected the command. It recovered the package entry point
`.webpack/main.js`, exact `kestrel:lookup:v3` IPC channel, string-type rejection,
and `.slice(0,12)` result cap. The owned command exited 0 with complete output
and verified cleanup. The original REA public CLI
`analyze-javascript-application <archive> --json` found the same channel.
Neither path executed the archived application.

Original archive SHA-256 remained
`c631e7f19d23092f15bd2174d97b9b356fc13bbf74ae78c81f29a758982ce540`.
Command Evidence ID:
`ev_f6d158fd230c87c4192f490ed8969c9d90c8f0a7b21bb398cae8a91b9d152575`.

This proves installed-tool execution and source extraction for this artifact.
It does not prove parity with the original provider's structured AST/relationship
graphs, automatic provider selection, native decompilation, or runtime behavior.
Ghidra/IDA/JADX were not configured or found on PATH; none was installed for this
check. Broad real-provider parity remains open.

Reproduce this non-billable comparison from the child project with its pinned
Node runtime: `node scripts/verify-provider.mjs`. It expects the existing parent
checkout's built CLI and installed ASAR package. Local artifacts are retained in
`.cache/live-acceptance/`: `provider-report.json`,
`local-provider-evidence.json`, `original-cli.json`, and `selected-app.asar`.

## Installed host

Temporarily registered the new absolute local launcher in the installed Claude
Desktop host and restarted it. The real host initialized the server, discovered
tools/resources, read the App resource and invoked `rea_workbench` with `{}`.
The host rendered the workbench in its conversation, then in its expanded App
surface. Visually verified dark and light themes, navigation to the empty
Evidence ledger, and return from fullscreen to the embedded layout. Text,
cards, navigation and controls were readable in the checked layouts.

Inference was explicitly disabled in the temporary server configuration. No
investigation was started and the App showed zero model requests. This is a
bounded empty-state acceptance check, not validation of populated projects,
native dialogs, all workbench views, or all host products.

The original host configuration was backed up and restored byte-for-byte;
unrelated server registrations were preserved. The temporary host was exited.
Protocol and restoration records remain locally in
`.cache/live-acceptance/host-protocol.log` and `host-registration.json`.
No changes were published.
