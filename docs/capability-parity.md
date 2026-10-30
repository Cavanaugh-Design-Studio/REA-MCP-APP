# Broad capability parity

October 30 follow-up: the four requested capability groups now have internal
implementations; see [implementation and acceptance](capability-implementation.md).
The October 29 measurements below are historical. Re-run package measurements
after the added semantic closure; do not reuse the earlier package reduction.
Live native/device and general model parity remain unverified.

The acceptance target is the original app's useful outcomes across every target
family, with a smaller MCP and package footprint. Current verdict: **incomplete**.
Four tools can dispatch broad investigations, but tool count and the availability
of a shell do not establish equivalent analysis.

The baseline is the local `rea-agents` 6.3.0 checkout in `../rea-main`.
[Requirements and gaps](capability-parity.json) cover all 15 families from its
README: native binaries, ELF layout, EVM, recorded crashes, JavaScript/Electron,
websites, saved captures, .NET, APK code, Android devices, JEB, Android resources,
firmware, packages/Apple resources and process behavior. This is a capability
map, not a copy of its provider/tool catalog.

## What is established

The local comparison on October 29, 2026 used Node 24.18.0 and npm 11.16.0.

| Measurement                         |        Original |     MCP App |
| ----------------------------------- | --------------: | ----------: |
| Model-facing tools                  |             180 |           4 |
| All registered tools                |             180 |          15 |
| Model-facing serialized definitions | 2,200,070 bytes | 4,653 bytes |
| All serialized definitions          | 2,200,070 bytes | 9,264 bytes |

That is a 99.79% reduction in model-facing definition bytes and 99.58% across
the complete catalog. Hosts ignoring App visibility can still display all 15.
Offline npm package measurements also show a smaller app payload; consult the
latest report for exact bytes because documentation and build changes affect it.
These are discovery and package measurements, not total installation size,
memory use, latency, paid-model cost or equal task quality.

Three transparent static fixture tasks passed through one client assignment per
task, scripted internal decisions and real owned process execution:

| Task                         | Matched original observations                        | Remaining limits                                                          |
| ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Extracted Electron directory | Package entrypoint, IPC channel, exact source digest | Literal extraction does not reproduce AST/module/relationship analysis    |
| Electron ASAR                | Same observations, copied input and unchanged source | No runtime registration, unpacked companions or broad package parity      |
| Offline HAR                  | Exact URL, response status and public text payload   | No canonical network projection, credential redaction or mitmproxy parity |

Each app result retains canonical command Evidence, stdout/stderr, argv, exit
status, cleanup, inferred report and source identities. Model context/skill/tool
bytes, generation count and elapsed time are recorded. Model token and cost
fields remain null because no model was called. Original full-analysis timings
and focused app probes perform different work; their ratio is not an efficiency
claim. Original results and app runs remain separately inspectable.

The regression suite additionally checks canonical bundle identities and tamper
rejection, project history/stale writes, receipt-authenticated handoffs, process
cancellation and partial output. The new comparison regression exercises equal,
changed and missing DOM observations, incompatible replay environments, missing
source closure and a digest-valid fabricated pass. Only the retained
deterministic verifier assigns finite pass/fail/unknown. Identical observed DOM
bytes can compare unchanged while incompatible viewport selections still make
the finite behavioral claim unknown. These browser observations are simulated;
they do not establish a real browser capture lane.

## Remaining work

JavaScript and saved-capture coverage are partial. The other 13 target families
remain unverified at the full family level, including packages and process
behavior despite the bounded extraction/ownership checks. The skill's new
execution supplement provides routes and authority limits for each family; it
does not ship analysis engines or reproduce structured provider projections.

The largest functional gaps are canonical structured graph production, native
decompiler operations, .NET static metadata without additional tooling, owned
browser/PTY capture generation and live device/engine lanes. Imported canonical
Evidence remains usable; ordinary utility output must not impersonate a trusted
capture to satisfy feature proof. Existing workbench Code/Relationships views
cannot be declared equivalent merely because an agent recovered source text.

Close each gap using matched fixtures and actual configured tools on their
supported host. Include success, malformed input, missing tools, truncation,
cancellation, source identity and failed cleanup as applicable. Preserve exact
caller paths, output destinations, raw observations and independent source
closure. Prefer focused installed-tool recipes; add shared semantic code only
when needed to preserve an actual result contract. Do not restore the large
provider registration, manufacture tool wrappers or replace deterministic proof
with model agreement.

After mechanical coverage, run matching live-model tasks with the caller's
existing budget policy. Task selection, findings, retries, context, turns, usage
and elapsed time must all be measured. This work made no paid requests and did
not inspect or change the spend ledger, ceiling, secrets or model configuration.
Earlier bounded installed-host acceptance remains separate; the UI was not
changed or visually reaccepted in this pass.

## Reproduce

Build with the pinned toolchain, then run:

```sh
npm test
npm run verify:parity -- --original C:/analysis/rea-main
npm run verify:parity:strict -- --original C:/analysis/rea-main
```

The strict command intentionally fails full acceptance today. Reports retain
`universal_parity: "unverified"` and explicit family gaps even when all three
bounded probes pass. The latest report is `.cache/parity-latest.json`; each
unique `.cache/parity-*` directory retains its fixtures, original results,
app runs, package lists and full report. Failed original CLI calls retain their
diagnostics rather than becoming successful comparisons. Verification children
receive a credential-free environment and workspace-owned temp/cache paths.
The original application is read only; npm measurements are offline dry runs
with lifecycle scripts disabled. Nothing is installed or upgraded.
