import type { FeatureInspection } from "./FeatureProjectService.js";

const html = (text: string): string =>
  text.replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

/** Portable artifacts contain canonical sources and explicit finite verification scope. */
export const buildFeatureHandoff = (
  value: FeatureInspection,
): Readonly<Record<string, string>> => {
  const { project, ledger, verification } = value;
  const definition = project.definition;
  const json = (input: unknown) => JSON.stringify(input, null, 2) + "\n";
  const spec = `# ${definition.title}\n\n${definition.goal}\n\n## Target bindings\n\nOriginal: ${definition.original.location}\n\nCandidate: ${definition.candidate?.location ?? "Not selected"}\n\n## Required obligations\n\n${definition.obligations.reviewed_obligations.map((item) => `- ${item.obligation_id}: ${item.title} (${item.disposition})`).join("\n")}\n\n## Notes and unresolved scope\n\n${[...definition.notes, ...value.limitations].map((note) => `- ${note}`).join("\n")}\n`;
  const brief = `# Implementation brief\n\n${definition.goal}\n\nProject ${project.project_id}, revision ${project.revision}, SHA-256 ${value.sha256}.\n\nImplement in the caller-selected candidate workspace: ${definition.candidate?.location ?? "A candidate workspace must be selected before coding"}.\n\nUse feature-manifest.json for exact obligations, case inputs, owner bindings and Evidence references. Review evidence.json before interpreting inferred requirements. Run original and candidate cases with existing REA capture tools; compare their observations and retain results. A passing report covers only its declared claims. Do not treat missing, skipped or unknown cases as passing.\n`;
  return {
    ...(definition.implementation
      ? {
          "run-candidate.md": `# Run the supplied candidate\n\n${definition.implementation.launch_instructions.join("\n\n")}\n\nThese exact caller-supplied UTF-8 files are hashed in the handoff receipt. Their presence and digests establish delivered bytes; execution acceptance remains the declared scenario proof.\n`,
          ...Object.fromEntries(
            definition.implementation.files.map((file) => [
              `candidate/${file.path}`,
              file.content,
            ]),
          ),
        }
      : {}),
    "feature-spec.md": spec,
    "feature-manifest.json": json(project),
    "evidence.json": json(value.proof_input.evidence_bundle),
    "proofs.json": json(value.proofs),
    "ledger-input.json": json(value.proof_input),
    "obligation-ledger.json": json(ledger),
    "implementation-brief.md": brief,
    "verification.json": json({
      verification,
      historical_verification: value.historical_verification,
      readiness: value.readiness,
      limitations: value.limitations,
    }),
    "report.html": `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(definition.title)}</title><style>body{font:16px system-ui;background:#101827;color:#e8edf7;max-width:1100px;margin:40px auto;padding:24px}h1{color:#80b4ff}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1d2940;padding:20px;border-radius:12px}a{color:#a6c8ff}</style><h1>${html(definition.title)}</h1><p>${html(definition.goal)}</p><p>Project revision ${project.revision} · Feature readiness: ${value.readiness.state}</p><p>Finite declared scope; target bindings are caller declarations.</p><h2>Feature readiness</h2><pre>${html(json(value.readiness))}</pre><h2>Finite claim verification</h2><pre>${html(json(verification))}</pre><h2>Obligation ledger</h2><pre>${html(json(ledger.normalized_result))}</pre><h2>Historical claim results</h2><pre>${html(json(value.historical_verification))}</pre><h2>Reproduction</h2><p>Use <a href="feature-manifest.json">the feature manifest</a> and <a href="evidence.json">canonical Evidence bundle</a>. Execute the declared original/candidate scenarios; comparisons alone do not execute targets.</p></html>`,
    ...Object.fromEntries(
      definition.cases.map((item) => [
        `cases/${item.case_id}.json`,
        json(item),
      ]),
    ),
  };
};
