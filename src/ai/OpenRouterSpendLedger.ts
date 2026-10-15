import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/** Durable conservative admission. Reservations are never refunded after dispatch,
 * including crashes, cancellation, rejected or malformed upstream responses.
 * The price/context ceilings must additionally be enforced by provider routing.
 */
export class OpenRouterSpendLedger {
  constructor(
    readonly path: string,
    readonly limitUsd: number,
  ) {
    if (!isAbsolute(path) || !Number.isFinite(limitUsd) || limitUsd <= 0)
      throw new TypeError(
        "A positive spend ceiling and absolute ledger path are required",
      );
  }
  reserve(model: string, ceilingUsd: number): string | null {
    if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0)
      throw new TypeError("Invalid request spending ceiling");
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const policy = database
          .prepare("SELECT * FROM model_spend_policy WHERE singleton=1")
          .get()!;
        if (policy.limit_usd !== this.limitUsd || policy.violated !== 0)
          throw new TypeError("Spend policy requires reconciliation");
        if (
          database
            .prepare(
              "SELECT id FROM model_reservations WHERE cost_usd > reserved_usd LIMIT 1",
            )
            .get()
        )
          throw new TypeError(
            "Persisted upstream billing requires reconciliation",
          );
        const sum = database
          .prepare(
            "SELECT COALESCE(SUM(reserved_usd), 0) AS amount FROM model_reservations",
          )
          .get()!.amount;
        if (typeof sum !== "number" || sum + ceilingUsd > this.limitUsd) {
          database.exec("ROLLBACK");
          return null;
        }
        const id = randomUUID();
        database
          .prepare(
            "INSERT INTO model_reservations (id, model, reserved_usd, cost_usd) VALUES (?, ?, ?, NULL)",
          )
          .run(id, model, ceilingUsd);
        database.exec("COMMIT");
        return id;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    });
  }
  recordCost(id: string, cost: number | null): boolean {
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return false;
    return this.#withDatabase((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = database
          .prepare(
            "SELECT reserved_usd, cost_usd FROM model_reservations WHERE id=?",
          )
          .get(id);
        if (
          !row ||
          row.cost_usd !== null ||
          typeof row.reserved_usd !== "number"
        ) {
          database.exec("ROLLBACK");
          return false;
        }
        database
          .prepare("UPDATE model_reservations SET cost_usd=? WHERE id=?")
          .run(cost, id);
        // Never continue using a price ceiling contradicted by actual billing.
        if (cost !== null && cost > row.reserved_usd) {
          database
            .prepare(
              "UPDATE model_spend_policy SET violated=1 WHERE singleton=1",
            )
            .run();
          database.exec("COMMIT");
          return false;
        }
        database.exec("COMMIT");
        return true;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    });
  }
  #withDatabase<T>(run: (database: DatabaseSync) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    try {
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      database.exec(
        "CREATE TABLE IF NOT EXISTS model_spend_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), limit_usd REAL NOT NULL, violated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS model_reservations (id TEXT PRIMARY KEY, model TEXT NOT NULL, reserved_usd REAL NOT NULL, cost_usd REAL);",
      );
      database
        .prepare("INSERT OR IGNORE INTO model_spend_policy VALUES (1, ?, 0)")
        .run(this.limitUsd);
      const policy = database
        .prepare("SELECT * FROM model_spend_policy WHERE singleton=1")
        .get()!;
      if (policy.limit_usd !== this.limitUsd)
        throw new TypeError(
          "Spend policy differs or an upstream cost exceeded its reservation; reconciliation is required",
        );
      return run(database);
    } finally {
      database.close();
    }
  }
}
