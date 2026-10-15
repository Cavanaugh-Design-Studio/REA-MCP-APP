import { expect, it } from "vitest";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { SqliteFeatureProjectStore } from "../../../src/projects/SqliteFeatureProjectStore.js";
import { FeatureProjectService } from "../../../src/application/features/FeatureProjectService.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { writeFeatureHandoff } from "../../../src/projects/FeatureHandoffWriter.js";
import { buildFeatureHandoff } from "../../../src/application/features/FeatureHandoff.js";
import { browserVerificationFixture } from "../../../src/domain/browserScenarioVerification.fixture.js";
import { compareBrowserScenarioEvidence } from "../../../src/application/features/BrowserScenarioComparison.js";
import { FeatureInvestigationBinding } from "../../../src/application/features/FeatureInvestigationBinding.js";
import { InvestigationCoordinator } from "../../../src/application/agents/InvestigationCoordinator.js";
import { investigationInputSchema } from "../../../src/domain/agentInvestigation.js";
import { ok, err } from "../../../src/domain/result.js";
import { AnalysisProtocolError } from "../../../src/domain/analysisErrorCore.js";
import { featureDefinitionSchema } from "../../../src/domain/featureProject.js";
import { createHash } from "node:crypto";

it("delivers the exact declared candidate bytes and rejects digest/path substitutions before persistence", async () => {
  const directory = await createTestTempDirectory("rea-candidate-export-");
  const service = new FeatureProjectService(
    new SqliteFeatureProjectStore(join(directory, "projects.sqlite")),
  );
  const content = "export const annotation = 42;\n";
  const file = {
    path: "src/annotation.js",
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  const input = {
    ...definition(),
    implementation: {
      files: [
        file,
        { ...file, path: ".gitignore" },
        { ...file, path: ".github/workflows/test.yml" },
      ],
      launch_instructions: [
        "Run the explicitly supplied application entry point.",
      ],
    },
  };
  try {
    for (const path of [
      "../outside.js",
      "src/./annotation.js",
      "src/CON.txt",
      "src/annotation.js.",
    ])
      expect(
        service.create({
          ...input,
          implementation: {
            ...input.implementation,
            files: [{ ...file, path }],
          },
        }).ok,
      ).toBe(false);
    expect(
      service.create({
        ...input,
        implementation: {
          ...input.implementation,
          files: [{ ...file, sha256: "a".repeat(64) }],
        },
      }).ok,
    ).toBe(false);
    expect(
      service.create({
        ...input,
        implementation: {
          ...input.implementation,
          files: [
            { ...file, path: "a" },
            { ...file, path: "a-x" },
            { ...file, path: "a/x" },
          ],
        },
      }).ok,
    ).toBe(false);
    expect(
      service.create({
        ...input,
        implementation: {
          ...input.implementation,
          files: [file, { ...file, path: "SRC/ANNOTATION.JS" }],
        },
      }).ok,
    ).toBe(false);
    const created = service.create(input);
    if (!created.ok) throw created.error;
    const inspection = service.inspect(created.value.project_id);
    if (!inspection.ok) throw inspection.error;
    const exported = await writeFeatureHandoff(
      join(directory, "handoff"),
      buildFeatureHandoff(inspection.value),
    );
    if (!exported.ok) throw exported.error;
    expect(
      await readFile(
        join(directory, "handoff/candidate/src/annotation.js"),
        "utf8",
      ),
    ).toBe(content);
    expect(exported.value.files).toContainEqual({
      path: "candidate/src/annotation.js",
      sha256: file.sha256,
      bytes: Buffer.byteLength(content),
    });
    expect(
      await readFile(
        join(directory, "handoff/candidate/.github/workflows/test.yml"),
        "utf8",
      ),
    ).toBe(content);
  } finally {
    service.store.close();
  }
});

const definition = () => ({
  title: "Feature",
  goal: "Reproduce a finite behavior",
  original: {
    kind: "browser",
    location: "http://localhost:4100/",
    sha256: null,
  },
  candidate: null,
  evidence_bundle: createEvidenceBundle([]),
  obligations: {
    reviewed_obligations: [],
    manifest: { bindings: [], contradictions: [] },
  },
  specification: null,
  cases: [],
  notes: [],
});

it("releases each settled worker lease even when its terminal checkpoint fails", async () => {
  const directory = await createTestTempDirectory("rea-feature-terminal-");
  const service = new FeatureProjectService(
    new SqliteFeatureProjectStore(join(directory, "projects.sqlite")),
  );
  const binding = new FeatureInvestigationBinding(service);
  let markSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const coordinator = new InvestigationCoordinator(
    {
      models: { analyst: "fixture", reviewer: null },
      generate: async () =>
        ok({
          decision: {
            kind: "report",
            findings: [],
            unknowns: [],
            next_steps: [],
          },
          requestedModel: "fixture",
          returnedModel: null,
          provider: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        }),
    },
    {
      resolve: () => undefined,
      withScope: async (_signal, _sources, run) =>
        ok(
          await run(async () => {
            throw new Error("No tools expected");
          }),
        ),
    },
    (run) => binding.checkpoint(run),
    (id) => {
      const result = binding.settled(id);
      markSettled();
      return result;
    },
  );
  try {
    const project = service.create(definition());
    if (!project.ok) throw project.error;
    const assignment = investigationInputSchema.parse({
      question: "Review scope",
      review: false,
      feature: { project_id: project.value.project_id, expected_revision: 1 },
    });
    const original = service.recordJob.bind(service);
    service.recordJob = (id, raw) =>
      typeof raw === "object" &&
      raw !== null &&
      "state" in raw &&
      raw.state === "completed"
        ? err(new AnalysisProtocolError("Injected terminal storage failure"))
        : original(id, raw);
    expect(binding.prepare(assignment).ok).toBe(true);
    const started = coordinator.start(assignment);
    if (!started.ok) throw started.error;
    expect(binding.attach(started.value.run_id, assignment).ok).toBe(true);
    await settled;
    // The connection and project store remain open; liveness is per run.
    const recovered = service.inspect(project.value.project_id);
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.project.jobs[0]?.state).toBe("interrupted");
  } finally {
    await coordinator.close();
    service.store.close();
  }
});
it("rejects marked sensitive process input at the durable case boundary", () => {
  const scenario = {
    kind: "process",
    input: {
      executable: "tool",
      events: [
        {
          type: "input",
          at_ms: 0,
          data: "marked-private-input",
          sensitive: true,
        },
      ],
    },
  };
  const parsed = featureDefinitionSchema.safeParse({
    ...definition(),
    cases: [
      {
        case_id: "secret",
        title: "Secret input",
        obligation_ids: ["missing"],
        original: scenario,
        candidate: scenario,
      },
    ],
  });
  expect(parsed.success).toBe(false);
  if (!parsed.success)
    expect(
      parsed.error.issues.some((issue) =>
        issue.message.includes("sensitive input bytes"),
      ),
    ).toBe(true);
});
it("proves live worker ownership with a held lock and marks lost owners interrupted without replay", async () => {
  const directory = await createTestTempDirectory("rea-feature-owners-");
  const path = join(directory, "projects.sqlite");
  const a = new FeatureProjectService(new SqliteFeatureProjectStore(path));
  const b = new FeatureProjectService(new SqliteFeatureProjectStore(path));
  try {
    const project = a.create(definition());
    if (!project.ok) throw project.error;
    const owner = a.store.acquireOwner();
    if (!owner.ok) throw owner.error;
    const alive = b.store.ownerAlive(owner.value);
    if (!alive.ok) throw alive.error;
    expect(alive.value).toBe(true);
    const job = a.recordJob(project.value.project_id, {
      job_id: "owned-job",
      owner_id: owner.value,
      feature_revision: 1,
      state: "running",
      report: null,
      message: "Running",
    });
    if (!job.ok) throw job.error;
    const active = b.inspect(project.value.project_id);
    if (!active.ok) throw active.error;
    expect(active.value.project.jobs[0]?.state).toBe("running");
    a.store.close();
    const recovered = b.inspect(project.value.project_id);
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.project.jobs[0]?.state).toBe("interrupted");
    expect(recovered.value.project.jobs[0]?.message).toContain(
      "no operations were replayed",
    );
    const historical = b.inspect(project.value.project_id, job.value.revision);
    if (!historical.ok) throw historical.error;
    expect(historical.value.project.jobs[0]?.state).toBe("running");
  } finally {
    a.store.close();
    b.store.close();
  }
});
const browserDefinition = () => {
  const left = browserVerificationFixture();
  const right = browserVerificationFixture("http://localhost:4200/");
  const compared = compareBrowserScenarioEvidence({
    left: left.evidence,
    right: right.evidence,
    origin_pair: {
      before_origin: "http://localhost:4100",
      after_origin: "http://localhost:4200",
    },
    normalization: {
      rules: [
        {
          rule_id: "origin",
          artifacts: ["action_state"],
          match: "http://localhost:4100",
          replacement: "http://localhost:4200",
        },
      ],
    },
  });
  if (!compared.ok) throw compared.error;
  const value = {
    ...definition(),
    candidate: {
      kind: "browser",
      location: "http://localhost:4200/",
      sha256: null,
    },
    evidence_bundle: createEvidenceBundle([
      left.evidence,
      right.evidence,
      compared.value,
    ]),
    specification: {
      name: "Feature",
      claims: [
        {
          claim_id: "case",
          title: "Finite behavior",
          kind: "browser-behavior",
          dimension: "overall",
          comparison_evidence_id: compared.value.evidence_id,
        },
      ],
    },
    obligations: {
      reviewed_obligations: [
        {
          obligation_id: "feature.behavior",
          obligation_version: 1,
          title: "Observed behavior",
          application_layer: "application",
          family: "feature",
          target: {
            artifact_sha256: null,
            application_node_id: null,
            semantic_node_id: null,
            location: "http://localhost:4100/",
          },
          required: true,
          required_case_kinds: ["positive"],
          required_original_authority: "runtime",
          required_fixture_authority: "live-observation",
          required_verifier_authority: "live-observation",
          requires_parser_type: false,
          dependency_obligation_ids: [],
          residual_unknown_ids: [],
          unavailable_authority: [],
          required_next_evidence: [],
          disposition: "active",
          review_evidence_ids: [left.evidence.evidence_id],
        },
      ],
      manifest: { bindings: [], contradictions: [] },
    },
    cases: [
      {
        case_id: "case",
        title: "Finite behavior",
        obligation_ids: ["feature.behavior"],
        claim_ids: ["case"],
        original: { kind: "browser", input: left.scenario },
        candidate: { kind: "browser", input: right.scenario },
      },
    ],
  };
  return { value, left };
};

it("preserves historical passes while withholding proof for changed targets, cases and requirements", async () => {
  const directory = await createTestTempDirectory("rea-feature-bindings-");
  const service = new FeatureProjectService(
    new SqliteFeatureProjectStore(join(directory, "projects.sqlite")),
  );
  const { value, left } = browserDefinition();
  try {
    const created = service.create(value);
    if (!created.ok) throw created.error;
    const initial = service.inspect(created.value.project_id);
    if (!initial.ok) throw initial.error;
    expect(initial.value.verification?.status).toBe("pass");
    expect(initial.value.readiness.state).toBe("unknown");
    const changed = service.revise(created.value.project_id, 1, {
      ...value,
      candidate: { ...value.candidate, location: "http://localhost:4300/" },
    });
    if (!changed.ok) throw changed.error;
    const inspected = service.inspect(created.value.project_id);
    if (!inspected.ok) throw inspected.error;
    expect(inspected.value.verification?.status).toBe("unknown");
    expect(inspected.value.historical_verification?.status).toBe("pass");
    const invalidCase = {
      ...value,
      cases: [
        {
          ...value.cases[0],
          original: {
            kind: "browser",
            input: {
              ...left.scenario,
              actions: [left.scenario.actions[0], left.scenario.actions[0]],
            },
          },
        },
      ],
    };
    expect(service.revise(created.value.project_id, 2, invalidCase).ok).toBe(
      false,
    );
    const newBinding = service.revise(created.value.project_id, 2, {
      ...value,
      obligations: {
        ...value.obligations,
        manifest: {
          bindings: [
            {
              obligation_id: "feature.behavior",
              owner: {
                module_path: "C:/candidate/changed.js",
                symbol: "changed",
                owner_sha256: "a".repeat(64),
              },
              parser_type: null,
              original_cases: [
                {
                  kind: "positive",
                  evidence_id: left.evidence.evidence_id,
                  location: "browser",
                },
              ],
              fixtures: [],
              verifier: null,
            },
          ],
          contradictions: [],
        },
      },
    });
    if (!newBinding.ok) throw newBinding.error;
    const staleOwner = service.inspect(created.value.project_id);
    if (!staleOwner.ok) throw staleOwner.error;
    expect(staleOwner.value.verification?.status).toBe("unknown");
    expect(staleOwner.value.historical_verification?.status).toBe("pass");
    expect(staleOwner.value.readiness.reasons.join(" ")).toContain("earlier");
  } finally {
    service.store.close();
  }
});
it("retains immutable revisions across owners, rejects stale writers and detects predecessor tampering", async () => {
  const directory = await createTestTempDirectory("rea-feature-store-");
  const path = join(directory, "projects.sqlite");
  const a = new FeatureProjectService(new SqliteFeatureProjectStore(path));
  const b = new FeatureProjectService(new SqliteFeatureProjectStore(path));
  try {
    const created = a.create(definition());
    if (!created.ok) throw created.error;
    const project = created.value;
    const updated = b.revise(project.project_id, 1, {
      ...definition(),
      title: "Changed",
    });
    if (!updated.ok) throw updated.error;
    expect(a.revise(project.project_id, 1, definition()).ok).toBe(false);
    const historical = a.inspect(project.project_id, 1);
    if (!historical.ok) throw historical.error;
    expect(historical.value.project.definition.title).toBe("Feature");
    a.store.close();
    const reopened = a.inspect(project.project_id);
    if (!reopened.ok) throw reopened.error;
    expect(reopened.value.project.revision).toBe(2);
    expect(reopened.value.readiness.state).toBe("unknown");
    const database = new DatabaseSync(path);
    try {
      database
        .prepare("UPDATE feature_revisions SET document=? WHERE revision=1")
        .run(
          JSON.stringify({
            ...project,
            definition: { ...project.definition, title: "Tampered" },
          }),
        );
    } finally {
      database.close();
    }
    expect(a.inspect(project.project_id).ok).toBe(false);
  } finally {
    a.store.close();
    b.store.close();
  }
});
it("preflights invalid proof before saving and exports an inspectable finite handoff without overwriting", async () => {
  const directory = await createTestTempDirectory("rea-feature-export-");
  const service = new FeatureProjectService(
    new SqliteFeatureProjectStore(join(directory, "projects.sqlite")),
  );
  try {
    const invalid = service.create({
      ...definition(),
      specification: {
        name: "Invalid",
        claims: [
          {
            claim_id: "claim",
            kind: "browser-behavior",
            dimension: "overall",
            title: "Missing",
            comparison_evidence_id: `ev:${"a".repeat(64)}`,
          },
        ],
      },
    });
    expect(invalid.ok).toBe(false);
    const listed = service.store.list();
    if (!listed.ok) throw listed.error;
    expect(listed.value).toHaveLength(0);
    const created = service.create(definition());
    if (!created.ok) throw created.error;
    const inspection = service.inspect(created.value.project_id);
    if (!inspection.ok) throw inspection.error;
    const output = join(directory, "handoff");
    const exported = await writeFeatureHandoff(
      output,
      buildFeatureHandoff(inspection.value),
    );
    if (!exported.ok) throw exported.error;
    expect(exported.value.files.map((item) => item.path)).toContain(
      "implementation-brief.md",
    );
    const original = await readFile(
      join(output, "feature-manifest.json"),
      "utf8",
    );
    expect(
      (
        await writeFeatureHandoff(output, {
          "feature-manifest.json": "changed",
        })
      ).ok,
    ).toBe(false);
    expect(await readFile(join(output, "feature-manifest.json"), "utf8")).toBe(
      original,
    );
    expect(
      JSON.parse(await readFile(join(output, "handoff-receipt.json"), "utf8"))
        .files,
    ).toHaveLength(9);
  } finally {
    service.store.close();
  }
});
