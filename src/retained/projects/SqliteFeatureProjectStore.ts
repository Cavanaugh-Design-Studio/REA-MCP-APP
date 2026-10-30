import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FeatureProjectStore } from "../application/features/FeatureProjectStore.js";
import {
  parseFeatureProject,
  featureProjectDigest,
  type FeatureProject,
} from "../domain/featureProject.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";

/** Local transactional persistence. Construction does not create files. */
export class SqliteFeatureProjectStore implements FeatureProjectStore {
  #database: DatabaseSync | undefined;
  readonly #owners = new Map<string, DatabaseSync>();
  constructor(private readonly path: string) {
    if (!isAbsolute(path))
      throw new TypeError("Feature store path must be absolute");
  }
  #open(): DatabaseSync {
    if (this.#database) return this.#database;
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    try {
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS feature_revisions (project_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(project_id, revision));",
      );
      this.#database = database;
      return database;
    } catch (cause) {
      database.close();
      throw cause;
    }
  }
  #decode(row: Record<string, unknown> | undefined): FeatureProject {
    return this.#decodeHistory(row).project;
  }
  #decodeHistory(row: Record<string, unknown> | undefined) {
    const value = this.#validateRow(row);
    const sources = new Set(
      value.definition.evidence_bundle.records.map(
        (record) => record.evidence_id,
      ),
    );
    let current = value;
    while (current.revision > 1) {
      const predecessor = this.#open()
        .prepare(
          "SELECT * FROM feature_revisions WHERE project_id=? AND revision=?",
        )
        .get(current.project_id, current.revision - 1);
      const previous = this.#validateRow(predecessor);
      if (featureProjectDigest(previous) !== current.previous_sha256)
        throw new TypeError("Feature revision chain disagrees");
      for (const record of previous.definition.evidence_bundle.records)
        sources.add(record.evidence_id);
      current = previous;
    }
    if (current.previous_sha256 !== null)
      throw new TypeError("Initial feature revision has a predecessor");
    return { project: value, sources: [...sources] };
  }
  #validateRow(row: Record<string, unknown> | undefined): FeatureProject {
    if (
      !row ||
      typeof row.document !== "string" ||
      typeof row.digest !== "string"
    )
      throw new TypeError("Feature project or revision is unavailable");
    const value = parseFeatureProject(JSON.parse(row.document));
    if (
      featureProjectDigest(value) !== row.digest ||
      value.project_id !== row.project_id ||
      value.revision !== row.revision
    )
      throw new TypeError("Feature project integrity check failed");
    return value;
  }
  read(id: string, revision?: number): Result<FeatureProject, AnalysisError> {
    return this.#guard(() =>
      this.#decode(
        revision === undefined
          ? this.#open()
              .prepare(
                "SELECT * FROM feature_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1",
              )
              .get(id)
          : this.#open()
              .prepare(
                "SELECT * FROM feature_revisions WHERE project_id=? AND revision=?",
              )
              .get(id, revision),
      ),
    );
  }
  sourceHistory(id: string): Result<readonly string[], AnalysisError> {
    return this.#guard(
      () =>
        this.#decodeHistory(
          this.#open()
            .prepare(
              "SELECT * FROM feature_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1",
            )
            .get(id),
        ).sources,
    );
  }
  list(): Result<readonly FeatureProject[], AnalysisError> {
    return this.#guard(() =>
      this.#open()
        .prepare(
          "SELECT r.* FROM feature_revisions r WHERE revision=(SELECT MAX(revision) FROM feature_revisions WHERE project_id=r.project_id) ORDER BY project_id",
        )
        .all()
        .map((row) => this.#decode(row)),
    );
  }
  commit(
    raw: FeatureProject,
    expectedRevision: number,
  ): Result<FeatureProject, AnalysisError> {
    return this.#guard(() => {
      const value = parseFeatureProject(raw);
      const database = this.#open();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database
          .prepare(
            "SELECT * FROM feature_revisions WHERE project_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(value.project_id);
        const previous = row ? this.#decode(row) : undefined;
        if (
          (previous?.revision ?? 0) !== expectedRevision ||
          value.revision !== expectedRevision + 1 ||
          value.previous_sha256 !==
            (previous ? featureProjectDigest(previous) : null)
        )
          throw new TypeError(
            "Feature revision conflict: read the current revision before updating",
          );
        database
          .prepare("INSERT INTO feature_revisions VALUES(?, ?, ?, ?)")
          .run(
            value.project_id,
            value.revision,
            featureProjectDigest(value),
            JSON.stringify(value),
          );
        database.exec("COMMIT");
        return value;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    });
  }
  #guard<T>(run: () => T): Result<T, AnalysisError> {
    try {
      return ok(run());
    } catch (cause) {
      return err(
        new AnalysisProtocolError(
          cause instanceof TypeError
            ? cause.message
            : "Feature project storage failed",
          { cause },
        ),
      );
    }
  }
  #ownerPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(id))
      throw new TypeError("Invalid feature job owner identity");
    return join(`${this.path}.leases`, `${id}.sqlite`);
  }
  acquireOwner(): Result<string, AnalysisError> {
    return this.#guard(() => {
      const id = randomUUID();
      const path = this.#ownerPath(id);
      mkdirSync(dirname(path), { recursive: true });
      const database = new DatabaseSync(path);
      try {
        database.exec(
          "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id TEXT); BEGIN IMMEDIATE;",
        );
      } catch (cause) {
        database.close();
        throw cause;
      }
      this.#owners.set(id, database);
      return id;
    });
  }
  ownerAlive(id: string): Result<boolean, AnalysisError> {
    return this.#guard(() => {
      if (this.#owners.has(id)) return true;
      const path = this.#ownerPath(id);
      if (!existsSync(path)) return false;
      const database = new DatabaseSync(path, { open: true });
      try {
        database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;");
        return false;
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "errcode" in cause &&
          (cause.errcode === 5 || cause.errcode === 6)
        )
          return true;
        throw cause;
      } finally {
        database.close();
      }
    });
  }
  releaseOwner(id: string): Result<void, AnalysisError> {
    return this.#guard(() => {
      const owner = this.#owners.get(id);
      if (!owner) return;
      owner.close();
      this.#owners.delete(id);
    });
  }
  close(): void {
    for (const [id, owner] of this.#owners) {
      owner.close();
      this.#owners.delete(id);
    }
    this.#database?.close();
    this.#database = undefined;
  }
}
