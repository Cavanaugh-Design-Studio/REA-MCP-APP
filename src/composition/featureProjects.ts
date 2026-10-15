import { homedir } from "node:os";
import { join } from "node:path";
import { SqliteFeatureProjectStore } from "../projects/SqliteFeatureProjectStore.js";
import { FeatureProjectService } from "../application/features/FeatureProjectService.js";

/** A fresh lazy store shares durable revisions, never live provider ownership. */
export const createFeatureProjectService = (
  environment: Readonly<NodeJS.ProcessEnv>,
) =>
  new FeatureProjectService(
    new SqliteFeatureProjectStore(
      environment.REA_PROJECT_STORE ??
        join(homedir(), ".rea", "feature-projects.sqlite"),
    ),
  );
