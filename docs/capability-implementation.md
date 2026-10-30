# Capability implementation: October 30, 2026

The requested capability implementations are present. Full parity remains an
acceptance question, not a tool-count claim.

| Internal operation               | Implemented behavior                                                                                                        | Acceptance scope                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `analyze_javascript_application` | Inert AST/module/import/IPC/semantic graphs, exact source identities and unresolved edges                                   | Real parser/worker through one MCP assignment; target bootstrap never runs                                                        |
| `inspect_managed_code`           | PE/CLR identity, metadata, CIL offsets/instructions and P/Invoke declarations; no CLR loading or external .NET installation | Synthetic source-owned PE fixtures; original parser and bounds retained                                                           |
| `project_analysis_graph`         | Authenticated managed source joins and relationship graph; inferred interpretation                                          | Exact source closure and matching artifact/MVID required                                                                          |
| `inspect_native_code`            | Function inventory pages or exact-address pseudocode, assembly, CFG, calls and references through Ghidra                    | Integration built; live engine acceptance requires caller-installed Ghidra/JDK                                                    |
| `capture_browser_scenario`       | Explicit browser actions, DOM/accessibility/network/screenshot selections, canonical controlled-replay Evidence             | Real installed Chrome/local HTTP fixture; isolated profile, retained Job Object/process-group ownership and cleanup               |
| `capture_device`                 | Explicit serial, byte-exact PNG, validated UI XML, bounded logcat and properties; exclusive caller output path              | Simulated device protocol with real owned process; physical/emulator acceptance requires caller-installed adb and selected device |
| `inspect_analysis_view`          | Bounded authenticated JS/native/managed views and graph pages                                                               | Complete sources remain local; models receive a summary when full records exceed their context allocation                         |

These are internal outcome tools. The host still sees four model-facing tools
and eleven App-only operations. No original catalog is forwarded to either the
host or internal models. `capability-source-manifest.json` records the selected
source closure and adaptations; upstream attribution and MIT license remain.

The graph UI adds source selection, filtering and relationship pages while
retaining Evidence provenance. Managed Code views select the appropriate
metadata/CIL/declaration collection. Graph interpretations do not mark a feature
verified. Browser captures retain exact launch argv, bounded diagnostics and
cleanup receipts; device captures retain raw bytes at the selected destination.
Cancellation, partial output, malformed formats and cleanup failure remain
explicit. Model credentials are excluded from analysis child environments.

Native configuration uses server-side `REA_GHIDRA_INSTALL_DIR` and
`REA_GHIDRA_JAVA_HOME`, both absolute. Devices use `REA_ADB_PATH` or an installed
adb on PATH, with an explicit serial on every acquisition. No engine, JDK,
Android SDK, browser or device software is installed automatically.

Current bounds: browser execution uses owned launch mode and public inputs;
secret-bearing or attached external sessions are not silently relabeled as
controlled launches. Typed JS analysis accepts inert directories/ASAR/ZIP-style
artifacts; DMG/PKG require a separately extracted working copy. Native engine
support remains the retained platform-specific Ghidra support (including the
experimental Windows PE lane), not universal native compatibility.

Build with pinned Node/npm, then run `npm test`, `npm run verify:capabilities`
and `npm run verify:parity`. Reports/fixtures remain in `.cache/capability-tests`
and `.cache/parity-*`. Browser tests need an installed browser, selected through
`REA_TEST_BROWSER` when the default Chrome path is unavailable. A host sandbox
can prevent Chrome startup; this does not establish an application-level pass.

The full-parity strict gate remains incomplete until native/device live lanes,
the other target families and matching live-model tasks have supporting
evidence. This change does not raise spending limits or make inference calls.
OpenTelemetry and internal research/planning were added subsequently; see
[observability](observability.md) and [research/planning](research-and-planning.md).
Cap'n Proto and DeepSeek Harness remain proposals, not runtime dependencies.

The local acceptance comparison recovered exactly matching normalized results
and canonical Evidence IDs against the original CLI for JavaScript application
analysis, managed identity, managed members/CIL and managed native boundaries.
The real browser fixture executed independently twice and passed the retained
finite DOM/screenshot verifier. The measured package payload is approximately
44% smaller than the original after adding the semantic closure; the public
model definitions remain 4,653 bytes. Reports are retained at
`.cache/structured-parity/report.json` and `.cache/parity-latest.json`.
Lint has no errors; complexity/length warnings remain.
