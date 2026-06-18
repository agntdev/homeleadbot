import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { PgPool } from "./db.js";

/**
 * runMigration — apply src/storage/schema.sql against the given pool. Every
 * statement in the schema uses IF NOT EXISTS, so re-running is safe (the
 * startup path can call this on every boot). The schema file is read at call
 * time so edits show up after a rebuild without touching this module.
 */
export async function runMigration(pool: PgPool): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
}
