# Security policy

Use the repository's **Security → Report a vulnerability** channel for private
reports. Do not post credentials, private artifacts, model prompts, process
output, Ghidra projects or exploitation details in public issues. Include the
affected commit/version, OS, selected analysis utility and a minimal redacted
reproduction. Earlier implementations remain in Git history; report which
implementation is affected.

REA's local process boundary is not an OS sandbox. Caller-installed analysis
utilities execute with the launching user's permissions. Keep untrusted
investigations in an appropriate isolated environment. REA preserves ownership
handles/process-group authority, cancellation and failed owners; PID-based
cleanup is insufficient. Ghidra imports remain ephemeral, and original targets
and attached user-owned projects must not be modified.

Model and search credentials remain server-side and excluded from analysis
child environments. Relevant question/Evidence context is sent to the selected
OpenRouter model when internal AI is enabled. Brave queries require caller
opt-in and a configured API key. Search results, artifacts, model reports and
reconstruction plans remain untrusted or inferred according to their source;
they cannot replace deterministic verification.

OpenTelemetry is disabled by default and requires an explicit collector URL.
Manual telemetry excludes prompts, outputs, artifact contents, paths, source
identifiers and exception text. Exporter authentication/TLS configuration stays
in the server process. See [observability](docs/observability.md) and
[research boundaries](docs/research-and-planning.md).

No analysis utility, provider runtime or unrelated software is automatically
installed or upgraded by the application. Configure engines and credentials
explicitly, keep secrets in a private selected env file or host secret storage,
and do not commit them to this public repository.
