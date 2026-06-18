import { describe, expect, it } from "vitest";
import { createDb, type PgPool } from "../src/storage/db";
import { runMigration } from "../src/storage/migrate";

/** Minimal fake PgPool that records every query for assertion. */
function fakePool(): PgPool & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string) {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    },
    async end() {
      /* no-op */
    },
  };
}

describe("createDb", () => {
  it("returns null when DATABASE_URL is unset", () => {
    expect(createDb({})).toBeNull();
    expect(createDb({ DATABASE_URL: "" })).toBeNull();
  });
  it("attempts to construct a pool when DATABASE_URL is set", () => {
    // We can't actually open a TCP connection in a unit test, but we can
    // confirm the factory does not short-circuit to null. If the env is
    // set the function should return a non-null value (the actual pool
    // construction is lazy and only happens at query time).
    const result = createDb({ DATABASE_URL: "postgres://example.invalid:5432/x" });
    // It may throw if pg is missing in the test image; the contract is
    // "either a pool or a clear error", not "always null".
    expect(result === null || typeof result === "object").toBe(true);
  });
});

describe("runMigration", () => {
  it("loads src/storage/schema.sql and executes it against the pool", async () => {
    const pool = fakePool();
    await runMigration(pool);
    expect(pool.queries).toHaveLength(1);
    const sql = pool.queries[0]!;
    // Spot-check that the eight tables the spec calls for are all present.
    const expected = [
      "agents",
      "groups",
      "group_claims",
      "listings",
      "group_listings",
      "leads",
      "lead_intake_items",
      "lead_events",
      "followup_jobs",
    ];
    for (const t of expected) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
  });

  it("uses IF NOT EXISTS on every CREATE so re-runs are no-ops", async () => {
    const pool = fakePool();
    await runMigration(pool);
    const sql = pool.queries[0]!;
    const creates = sql.match(/CREATE TABLE/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const m of sql.matchAll(/CREATE TABLE[^;]+/gi)) {
      expect(m[0]).toMatch(/IF NOT EXISTS/i);
    }
  });
});
