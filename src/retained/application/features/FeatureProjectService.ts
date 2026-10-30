import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FeatureProjectStore } from "./FeatureProjectStore.js";
import {
  featureDefinitionSchema,
  featureProjectDigest,
  featureProofScopeDigest,
  parseFeatureProject,
  type FeatureProject,
  featureJobSchema,
} from "../../domain/featureProject.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { ok, err, type Result } from "../../domain/result.js";
import { verifyReconstruction } from "../../domain/reconstructionVerification.js";
import { buildReconstructionObligationLedgerEvidenceValidated } from "../ReconstructionObligationLedgerService.js";
import type { Evidence } from "../../domain/evidence.js";
import type { ReconstructionVerificationResult } from "../../domain/reconstructionVerificationSchemas.js";
import { bindFeatureVerification } from "../../domain/featureVerificationBinding.js";
import { deriveFeatureRendererProof } from "./FeatureRendererProof.js";
import type { ReconstructionObligationLedgerInput } from "../../domain/reconstructionObligationLedgerSchemas.js";
import { comparisonSourceEvidenceSides } from "../../domain/comparisonSourceEvidence.js";
import type { FeatureDefinition } from "../../domain/featureProject.js";

const candidateCaptures = (definition: FeatureDefinition) => {
  const records = new Map(
    definition.evidence_bundle.records.map((record) => [
      record.evidence_id,
      record,
    ]),
  );
  return new Map(
    definition.specification?.claims.map((claim) => {
      const comparison = records.get(claim.comparison_evidence_id);
      return [
        claim.comparison_evidence_id,
        comparison ? comparisonSourceEvidenceSides(comparison).right : [],
      ] as const;
    }),
  );
};

export interface FeatureInspection {
  readonly project: FeatureProject;
  readonly sha256: string;
  readonly ledger: Evidence;
  readonly proofs: readonly Evidence[];
  readonly proof_input: ReconstructionObligationLedgerInput;
  readonly verification: ReconstructionVerificationResult | null;
  readonly historical_verification: ReconstructionVerificationResult | null;
  readonly readiness: {
    state: "ready" | "fail" | "unknown";
    reasons: string[];
  };
  readonly limitations: string[];
}

/** Feature state owns references and revisions; existing services own Evidence and closure. */
export class FeatureProjectService {
  constructor(readonly store: FeatureProjectStore) {}
  create(raw: unknown): Result<FeatureProject, AnalysisError> {
    const definition = featureDefinitionSchema.safeParse(raw);
    if (!definition.success)
      return err(
        new AnalysisInputError("create_feature_project", {
          cause: definition.error,
        }),
      );
    const now = new Date().toISOString();
    return this.#commit(
      {
        schema_version: 1,
        project_id: randomUUID(),
        revision: 1,
        previous_sha256: null,
        proof_scope_sha256: featureProofScopeDigest(definition.data),
        created_at: now,
        updated_at: now,
        definition: definition.data,
        jobs: [],
      },
      0,
    );
  }
  revise(
    id: string,
    expectedRevision: number,
    raw: unknown,
  ): Result<FeatureProject, AnalysisError> {
    const current = this.store.read(id);
    if (!current.ok) return current;
    const parsed = featureDefinitionSchema.safeParse(raw);
    if (!parsed.success)
      return err(
        new AnalysisInputError("revise_feature_project", {
          cause: parsed.error,
        }),
      );
    const previousComparisons = new Set(
      current.value.definition.specification?.claims.map(
        (claim) => claim.comparison_evidence_id,
      ),
    );
    let freshCandidates = false;
    const history = this.store.sourceHistory(id);
    if (!history.ok) return history;
    try {
      const previousCaptures = new Set(history.value);
      freshCandidates = [...candidateCaptures(parsed.data).values()].every(
        (captures) =>
          captures.length === 1 && !previousCaptures.has(captures[0]!),
      );
    } catch {
      // Full verification below returns the producing comparison's typed error.
    }
    const newProof =
      freshCandidates &&
      parsed.data.specification !== null &&
      parsed.data.specification.claims.every(
        (claim) => !previousComparisons.has(claim.comparison_evidence_id),
      );
    return this.#commit(
      {
        ...current.value,
        definition: parsed.data,
        proof_scope_sha256: newProof
          ? featureProofScopeDigest(parsed.data)
          : current.value.proof_scope_sha256,
        revision: expectedRevision + 1,
        previous_sha256: featureProjectDigest(current.value),
        updated_at: new Date().toISOString(),
      },
      expectedRevision,
    );
  }
  inspect(id: string, revision?: number) {
    const read = this.store.read(id, revision);
    if (!read.ok) return read;
    if (revision !== undefined) return this.evaluate(read.value);
    const jobs = [...read.value.jobs];
    let changed = false;
    for (const [index, job] of jobs.entries()) {
      if (job.state !== "running") continue;
      const alive = this.store.ownerAlive(job.owner_id);
      if (!alive.ok) return alive;
      if (!alive.value) {
        jobs[index] = {
          ...job,
          state: "interrupted",
          message:
            "The worker owner is no longer active. Partial reports are historical; no operations were replayed.",
        };
        changed = true;
      }
    }
    if (!changed) return this.evaluate(read.value);
    const updated = this.store.commit(
      {
        ...read.value,
        jobs,
        revision: read.value.revision + 1,
        previous_sha256: featureProjectDigest(read.value),
        updated_at: new Date().toISOString(),
      },
      read.value.revision,
    );
    return updated.ok ? this.evaluate(updated.value) : updated;
  }
  recordJob(id: string, raw: unknown): Result<FeatureProject, AnalysisError> {
    const job = featureJobSchema.safeParse(raw);
    if (!job.success)
      return err(
        new AnalysisInputError("record_feature_job", { cause: job.error }),
      );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const read = this.store.read(id);
      if (!read.ok) return read;
      if (job.data.feature_revision > read.value.revision)
        return err(
          new AnalysisProtocolError(
            "Feature job references an unavailable project revision",
          ),
        );
      const existing = read.value.jobs.find(
        (item) => item.job_id === job.data.job_id,
      );
      if (
        existing &&
        (existing.owner_id !== job.data.owner_id ||
          existing.feature_revision !== job.data.feature_revision)
      )
        return err(
          new AnalysisProtocolError("Feature job ownership disagrees"),
        );
      const jobs = [
        ...read.value.jobs.filter((item) => item.job_id !== job.data.job_id),
        job.data,
      ];
      const committed = this.store.commit(
        {
          ...read.value,
          jobs,
          revision: read.value.revision + 1,
          previous_sha256: featureProjectDigest(read.value),
          updated_at: new Date().toISOString(),
        },
        read.value.revision,
      );
      if (
        committed.ok ||
        !committed.error.message.includes("revision conflict")
      )
        return committed;
    }
    return err(
      new AnalysisProtocolError(
        "Feature job checkpoint conflicted with concurrent project updates",
      ),
    );
  }
  evaluate(project: FeatureProject): Result<FeatureInspection, AnalysisError> {
    try {
      const historical =
        project.definition.specification === null
          ? null
          : verifyReconstruction(
              project.definition.specification,
              project.definition.evidence_bundle,
            );
      const bound = bindFeatureVerification(project, historical);
      const derived =
        project.proof_scope_sha256 ===
        featureProofScopeDigest(project.definition)
          ? deriveFeatureRendererProof(project.definition)
          : {
              proof: null,
              bundle: project.definition.evidence_bundle,
              manifest: project.definition.obligations.manifest,
            };
      const proofInput = {
        ...project.definition.obligations,
        evidence_bundle: derived.bundle,
        manifest: derived.manifest,
      };
      const ledger =
        buildReconstructionObligationLedgerEvidenceValidated(proofInput);
      if (!ledger.ok) return ledger;
      const ledgerStatus =
        ledger.value.normalized_result !== null &&
        typeof ledger.value.normalized_result === "object" &&
        !Array.isArray(ledger.value.normalized_result)
          ? ledger.value.normalized_result.status
          : "unknown";
      const reasons = [
        ...bound.reasons,
        ...(ledgerStatus === "ready"
          ? []
          : ["Canonical obligation ledger is not ready."]),
      ];
      const state =
        ledgerStatus === "failed" || bound.verification?.status === "fail"
          ? "fail"
          : bound.verification?.status === "pass" && reasons.length === 0
            ? "ready"
            : "unknown";
      return ok({
        project,
        sha256: featureProjectDigest(project),
        ledger: ledger.value,
        proofs: derived.proof === null ? [] : [derived.proof],
        proof_input: proofInput,
        verification: bound.verification,
        historical_verification: historical,
        readiness: { state, reasons },
        limitations: [
          "Feature target bindings are caller declarations; current feature proof additionally requires exact observed identities and scenario bindings.",
        ],
      });
    } catch (cause) {
      return err(
        cause instanceof z.ZodError
          ? new AnalysisInputError("read_feature_project", { cause })
          : new AnalysisProtocolError(
              "Feature verification Evidence is invalid",
              { cause },
            ),
      );
    }
  }
  #commit(
    raw: FeatureProject,
    expected: number,
  ): Result<FeatureProject, AnalysisError> {
    try {
      const value = parseFeatureProject(raw);
      const evaluated = this.evaluate(value);
      return evaluated.ok ? this.store.commit(value, expected) : evaluated;
    } catch (cause) {
      return err(new AnalysisInputError("feature_project", { cause }));
    }
  }
}
