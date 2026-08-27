import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import type { DbConfig } from "./config.ts";

/**
 * Postgres access and a minimal migration runner. Migrations are plain SQL
 * files in migrations/, applied once each in filename order, inside a
 * transaction, tracked in schema_migrations.
 */

export type Db = pg.Pool;

export function createPool(config: DbConfig): Db {
  return new pg.Pool({ connectionString: config.url, max: 5 });
}

export async function runMigrations(
  db: Db,
  migrationsDir = new URL("../migrations", import.meta.url).pathname,
): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // The lock serializes concurrent starters; the INSERT is the idempotency check.
      await client.query("SELECT pg_advisory_xact_lock(727272)");
      const seen = await client.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [file],
      );
      if (seen.rowCount === 0) {
        const sql = await readFile(path.join(migrationsDir, file), "utf8");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        applied.push(file);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(
        `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      client.release();
    }
  }
  return applied;
}
