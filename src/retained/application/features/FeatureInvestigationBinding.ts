import type { FeatureProjectService } from "./FeatureProjectService.js";
import type {
  InvestigationInput,
  InvestigationRun,
} from "../../domain/agentInvestigation.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisProtocolError } from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Bind durable job records to a live owner; lease liveness is proved by the store adapter. */
export class FeatureInvestigationBinding {
  readonly #assignments = new Map<
    string,
    { projectId: string; revision: number; owner: string }
  >();
  constructor(private readonly features: FeatureProjectService) {}
  prepare(input: InvestigationInput): Result<void, AnalysisError> {
    if (!input.feature) return ok(undefined);
    const project = this.features.store.read(input.feature.project_id);
    if (!project.ok) return project;
    if (project.value.revision !== input.feature.expected_revision)
      return err(
        new AnalysisProtocolError(
          "Feature investigation requires the current expected revision",
        ),
      );
    const ids = new Set(
      project.value.definition.evidence_bundle.records.map(
        (item) => item.evidence_id,
      ),
    );
    if (
      input.sources.some(
        (item) =>
          !ids.has(
            item.kind === "retained-evidence"
              ? item.evidence_id
              : item.evidence.evidence_id,
          ),
      )
    )
      return err(
        new AnalysisProtocolError(
          "Attach assigned Evidence to the feature before starting its investigation",
        ),
      );
    return ok(undefined);
  }
  attach(
    runId: string,
    input: InvestigationInput,
  ): Result<void, AnalysisError> {
    if (!input.feature) return ok(undefined);
    const owner = this.features.store.acquireOwner();
    if (!owner.ok) return owner;
    this.#assignments.set(runId, {
      projectId: input.feature.project_id,
      revision: input.feature.expected_revision,
      owner: owner.value,
    });
    return this.#save(runId, null, "running");
  }
  checkpoint(run: InvestigationRun): Result<void, AnalysisError> {
    return this.#save(run.run_id, run, run.state);
  }
  settled(runId: string): Result<void, AnalysisError> {
    const assignment = this.#assignments.get(runId);
    if (!assignment) return ok(undefined);
    const released = this.features.store.releaseOwner(assignment.owner);
    if (released.ok) this.#assignments.delete(runId);
    return released;
  }
  #save(
    runId: string,
    report: InvestigationRun | null,
    state: InvestigationRun["state"],
  ): Result<void, AnalysisError> {
    const assignment = this.#assignments.get(runId);
    if (!assignment) return ok(undefined);
    const saved = this.features.recordJob(assignment.projectId, {
      job_id: runId,
      owner_id: assignment.owner,
      feature_revision: assignment.revision,
      state,
      report,
      message:
        report?.events.at(-1)?.message ??
        "Admitted durable feature investigation",
    });
    return saved.ok ? ok(undefined) : saved;
  }
}
