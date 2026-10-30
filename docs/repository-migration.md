# Repository replacement

This source tree replaces the earlier REA implementation in
`Cavanaugh-Design-Studio/REA-MCP-APP`. The previous main commit is
`4345cbe4f04d8d76abd7e089bff90a85aa0f538d`; its files and history remain
available through Git. This migration does not rewrite history or modify a
separate original REA checkout.

## Client migration

The earlier `rea-agents` CLI/provider catalog, website deployment, installers
and release workflows are superseded in this repository. The new private
package is `rea-mcp-app` 0.1.0 and starts through `scripts/launch.mjs` after
building. Existing `npx rea-agents` registrations still select the upstream
application; they do not launch this implementation.

Build the new checkout with its pinned Node/npm versions and update the MCP
host registration to the new absolute launcher path and selected private env
file, following [README](../README.md). Enable internal AI explicitly with
`REA_AI_ENABLED`, `OPENROUTER_API_KEY` and `REA_AI_ANALYST_MODEL`; no production
model default is selected. Optional reviewer, Brave Search and OpenTelemetry
settings are documented in `.env.example`. Restart/reconnect the host.

The client now assigns investigations through four model-facing tools:
`rea_workbench`, `start_investigation`, `read_investigation`, and
`cancel_investigation`. Eleven workbench operations remain App-only. Do not
translate old provider calls by guessing matching tool names.

Export canonical Evidence or feature handoffs through the earlier application
before retiring an old registration. Keep an independent backup of existing
project data and original artifacts. The replacement preserves canonical
Evidence/project semantics and provides Evidence import/export; it does not
automatically discover, overwrite or migrate another installation's database.

## Source and verification

The replacement retains the workbench, selected static parsers/graphs, owned
engine/capture protocols, canonical source identities, project revisions and
deterministic verification. Internal agents execute the investigation with the
bundled leanrea guide. Research and reconstruction planning are internal
capabilities; model findings and plans remain inferred.

Generated output, caches, credentials, caller targets and native binaries are
excluded from the source commit. Windows execution requires the package-owned
verified native component, built from the retained source on a Linux/MinGW-w64
host or explicitly supplied by the caller. CI builds it and checks the current
Node/npm application instead of invoking removed CLI/provider scripts. CI does
not publish an npm package or deploy the superseded website.

The strict parity gate remains incomplete. Live Ghidra, selected-device capture,
matching live-model quality and real Brave credentials require separate
configured acceptance. Published implementation availability does not establish
universal capability parity. Existing acceptance documents record their dates
and limits; historical footprint measurements are not current installation,
latency, memory or model-cost guarantees.

The replacement was checked locally with Node 24.18.0/npm 11.16.0: runtime/UI
build, runtime/UI typechecks, 25 passing tests without skips, package inclusion,
and staged source/diff checks. The final nullable Brave metadata adjustment also
passed its four focused tests. Actual current discovery measures 15 registered
tools, four model-facing tools, 9,528 complete definition bytes and 4,917
model-facing definition bytes. GitHub Linux/Windows/native-build CI is a
separate check; local Windows acceptance does not establish its result.
