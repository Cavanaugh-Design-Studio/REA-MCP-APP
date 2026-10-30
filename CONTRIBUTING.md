# Contributing

REA MCP App owns its investigation loop. Read [AGENTS.md](AGENTS.md) and
[the migration plan](docs/migration-plan.md) before changing execution,
Evidence, project persistence or tool contracts.

Use Node 24.18.0 (`.nvmrc`) and npm 11.16.0 (`packageManager`). Then run:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run --ignore-scripts
```

Windows execution tests require the matching verified Job Object component.
Build it on an existing Linux/MinGW-w64 build host using
`npm run build:windows-native` after building JavaScript, or select a matching
artifact directory through `REA_WINDOWS_NATIVE_DIR`. CI builds it from source
and passes it to the Linux/Windows checks. Do not commit generated binaries.
See [the component guide](native/windows/README.md).

Real browser acceptance requires an installed Chrome-compatible browser;
select it with `REA_TEST_BROWSER`. Missing browser/native prerequisites must
be reported as skips or failures, never as successful live coverage. Ghidra,
JDK, adb/device, live-model, Brave and hosted-collector acceptance are separate
configured lanes. Analysis tools and model/search credentials are caller-owned.

Use Conventional Commit subjects and PR titles. This implementation changes
the earlier CLI/MCP entrypoints and catalog: mark changes to that migration
with `!` and explain their effect. Preserve four model-facing tools, test the
actual advertised catalog and serialized size, and keep App-only contracts
explicit. Model agreement does not establish deterministic reconstruction proof.

Never commit secrets, `.env` files other than the example, `node_modules`,
`dist`, `.cache`, generated binaries, caller artifacts or local run reports.
Retain upstream license attribution. Keep verification proportional to the
change and record remaining acceptance limits. See
[repository migration](docs/repository-migration.md).
