import type { FeatureProject } from "../../domain/featureProject.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";

/** Atomic compare-and-swap revisions and immutable history are owned by the store adapter. */
export interface FeatureProjectStore {
  read(id: string, revision?: number): Result<FeatureProject, AnalysisError>;
  sourceHistory(id: string): Result<readonly string[], AnalysisError>;
  list(): Result<readonly FeatureProject[], AnalysisError>;
  commit(
    value: FeatureProject,
    expectedRevision: number,
  ): Result<FeatureProject, AnalysisError>;
  acquireOwner(): Result<string, AnalysisError>;
  releaseOwner(id: string): Result<void, AnalysisError>;
  ownerAlive(id: string): Result<boolean, AnalysisError>;
  close(): void;
}
