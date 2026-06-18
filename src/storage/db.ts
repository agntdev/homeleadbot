import { createRequire } from "node:module";

/**
 * The minimal pg surface we depend on. Declared as an interface so unit tests
 * can pass a fake client (no real PostgreSQL needed for the test suite).
 */
export interface PgPool {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

/**
 * createDb — build a PostgreSQL connection pool from DATABASE_URL, or return
 * null when the env var is unset (test harness, local dev without Postgres).
 *
 * Mirrors the toolkit's session-storage auto-select: when DATABASE_URL is set
 * we go through `pg`; when it isn't, the storage layers fall back to their
 * in-memory adapters so the test harness can run with zero infrastructure.
 *
 * The pool is loaded LAZILY (via createRequire) so a bot that never sets
 * DATABASE_URL doesn't pull `pg` into its module graph.
 */
export function createDb(
  env: { DATABASE_URL?: string } = process.env,
): PgPool | null {
  const url = env.DATABASE_URL;
  if (!url) return null;
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pg: any = require("pg");
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error("pg.Pool not found — is the `pg` package installed?");
  }
  return new Pool({ connectionString: url }) as PgPool;
}
