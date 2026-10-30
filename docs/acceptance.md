# Restart verification

For the October 29 broad-coverage follow-up, see
[capability parity](capability-parity.md). That pass expanded internal guidance
to all 15 target families, added repeatable matched static tasks and actual
package comparisons, and brought the regression suite to 12 passing tests.
Full capability parity remains unverified; the original results below retain
their earlier scope and date.

Verified locally on 2026-10-27 with Node 24.18.0 and npm 11.16.0.

## Passed

- Runtime build and UI bundle build.
- Runtime and UI TypeScript checks.
- Eleven focused tests, all passed with no skips.
- Real internal command execution after one client assignment, including retained
  Evidence, unchanged source input and exclusion of the model key from the child.
- Missing-executable fallback by the internal agent.
- Command output exhaustion retained as partial Evidence and a limited run.
- Cancellation drained an owned Windows process and its detached descendant.
- Workspace traversal failure preserved the outside file.
- Canonical project revisions, stale-write rejection and receipt-verified export.
- Legacy Evidence preserved exact IDs; tampered imports were rejected.
- Feature-bound internal editing completed without checkpoint-induced conflicts.
- Simulated provider HTTP requests contained the trusted skill and local tools;
  malformed reports retained usage and output exhaustion remained limited.
- Advertised schemas compiled through the SDK's dialect-aware AJV validator.
- Real compiled stdio discovery from a foreign working directory.
- Locked dependency audit: zero reported vulnerabilities after updating Zod.
- Package dry-run before final documentation/manifest annotations: 235 files,
  677,861 compressed bytes, 2,577,449 unpacked bytes;
  bundled UI, skill and native component present; secrets/caches absent.

## Measured catalog

| Measurement | Original | Restart |
| --- | ---: | ---: |
| Registered tools | 180 | 15 |
| Declared model-facing tools | 180 | 4 |
| Complete tool-definition JSON | 2,200,070 bytes | 9,264 bytes |
| Model-facing definition JSON | 2,200,070 bytes | 4,653 bytes |

The complete catalog's serialized definition size fell by 99.58%. This measures
discovery overhead, not task latency, model quality or universal capability parity.
The eleven workspace operations use MCP Apps visibility `app`; hosts that ignore
that metadata may expose all fifteen tools.

The Windows component's validated SHA-256 is
`fedfd4ce8b3e15784d1a6ef7e9ba7eb9052e8335a1c75b6d69cd7e94f29ab1f8`.
It was staged as ignored local build output with its matching manifest. Its
source and cross-build script are included; the cross-build was not rerun.

## Remaining acceptance limits

Model decisions and provider HTTP replies in the automated tests were simulated.
The follow-up [bounded acceptance check](live-acceptance.md) verified one real
ASAR extraction path and fresh rendering/navigation/theme/fullscreen behavior
in installed Claude Desktop. Live-model quality remains blocked by the existing
$20 admission ceiling, retained at the user's direction. Broad real-provider
parity, native decompiler lanes and matching-task model performance remain
unverified. See that report for the exact scope and local evidence.

Lint returned no errors. Complexity/length warnings remain in the ported UI and
new execution/orchestration code. This is not a warning-free maintenance gate.

The temporary client registration used for installed-host acceptance was removed
and the original configuration restored exactly. No private environment file,
original application or external repository was replaced or published. Setup
for the new launcher is documented in the root README.
