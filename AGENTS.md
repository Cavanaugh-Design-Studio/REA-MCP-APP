# REA MCP App

The product's internal agents perform investigations. The client agent submits
work and receives Evidence-backed results; it is not the analysis executor.

Use `leanrea/SKILL.md` as the internal investigation guide. Keep its upstream
attribution and benchmark limits. Do not copy the original REA provider catalog
or forward it to clients or internal models.

Preserve the workbench and canonical Evidence/project/process semantics listed
in `docs/migration-plan.md`. Model findings remain inferred. Preserve caller
paths, output, source identities, uncertainty, cancellation and failed owners.
Do not replace deterministic verification with model agreement.

Keep four model-facing tools. Workspace actions may be App-only with named
contracts. Count the actual advertised catalog and serialized bytes in tests.
Do not add tools or abstractions merely to wrap an external executable.

Keep credentials server-side and out of child environments. Analysis utilities
are bring-your-own. No automatic installation or upgrade of unrelated software.
Use the retained process ownership boundary rather than PID-based cleanup.

Use the pinned Node/npm toolchain. Changes stay inside this directory unless
the user requests changes elsewhere. The original application stays intact.
