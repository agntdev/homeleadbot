import { describe, expect, it, beforeEach } from "vitest";
import type { PgPool } from "../src/storage/db";
import { AgentStore, createAgentStore } from "../src/storage/agents";
import { GroupStore, createGroupStore } from "../src/storage/groups";

/** Fake PgPool that returns the canned rows you hand it for a given SQL
 *  pattern. Tracks every query for assertion. */
function fakePool(opts: { rowsByPattern?: Array<{ match: RegExp; rows: unknown[] }> } = {}): PgPool & {
  queries: Array<{ sql: string; params?: unknown[] }>;
} {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const rowsByPattern = opts.rowsByPattern ?? [];
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      for (const r of rowsByPattern) {
        if (r.match.test(sql)) return { rows: r.rows, rowCount: r.rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {
      /* no-op */
    },
  };
}

describe("AgentStore (Postgres-backed via fake pool)", () => {
  let pool: ReturnType<typeof fakePool>;
  let store: AgentStore;

  beforeEach(() => {
    pool = fakePool();
    // Bypass the env-driven factory and inject the pool directly. The
    // factory's contract is tested separately at the bottom of this file.
    store = createAgentStore({ DATABASE_URL: "postgres://x" }, pool);
  });

  it("registerFromTelegramUser persists a new agent", async () => {
    const { record, isNew } = await store.registerFromTelegramUser({
      id: 7777,
      first_name: "Dana",
      last_name: "Lopez",
      username: "dana_l",
    });
    expect(isNew).toBe(true);
    expect(record.telegram_id).toBe(7777);
    expect(record.display_name).toBe("Dana Lopez");
    expect(record.username).toBe("dana_l");
    // write + read happen; the INSERT path is the one we exercised.
    expect(pool.queries.some((q) => /INSERT INTO agents/i.test(q.sql))).toBe(true);
  });

  it("registerFromTelegramUser is idempotent for the same telegram_id (registered_at preserved)", async () => {
    // Pre-load the pool with an existing record so the read path returns it.
    const earlier = {
      telegram_id: 8888,
      display_name: "Eve Original",
      username: null,
      registered_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const pool2 = fakePool({
      rowsByPattern: [
        { match: /FROM agents WHERE telegram_id/i, rows: [earlier] },
      ],
    });
    const store2 = createAgentStore({ DATABASE_URL: "postgres://x" }, pool2);
    const { record, isNew } = await store2.registerFromTelegramUser({
      id: 8888,
      first_name: "Eve",
    });
    expect(isNew).toBe(false);
    expect(record.registered_at).toBe("2026-01-01T00:00:00.000Z");
    expect(record.display_name).toBe("Eve");
  });
});

describe("GroupStore (Postgres-backed via fake pool)", () => {
  it("claim persists a new group_claim AND upserts the parent groups row", async () => {
    const pool = fakePool();
    const store = createGroupStore({ DATABASE_URL: "postgres://x" }, pool);
    const { claim, isNew } = await store.claim(
      { id: -100200300, type: "supergroup", title: "Castro Buyers" },
      4242,
    );
    expect(isNew).toBe(true);
    expect(claim.group_id).toBe(-100200300);
    expect(claim.group_title).toBe("Castro Buyers");
    expect(claim.claimed_by).toBe(4242);
    const queries = pool.queries.map((q) => q.sql);
    expect(queries.some((s) => /INSERT INTO groups/i.test(s))).toBe(true);
    expect(queries.some((s) => /INSERT INTO group_claims/i.test(s))).toBe(true);
  });

  it("claim is a no-op when the group is already claimed", async () => {
    const existing = {
      group_id: -100200301,
      group_title: "Already Taken",
      claimed_by: 9999,
      claimed_at: "2026-02-02T00:00:00.000Z",
    };
    const pool = fakePool({
      rowsByPattern: [
        { match: /FROM group_claims WHERE group_id/i, rows: [existing] },
      ],
    });
    const store = createGroupStore({ DATABASE_URL: "postgres://x" }, pool);
    const { claim, isNew } = await store.claim({ id: -100200301, type: "supergroup" }, 4242);
    expect(isNew).toBe(false);
    expect(claim.claimed_by).toBe(9999);
    // No INSERT should have been issued.
    const inserts = pool.queries.filter((q) => /^INSERT/i.test(q.sql.trim()));
    expect(inserts).toHaveLength(0);
  });
});

describe("createAgentStore / createGroupStore env routing", () => {
  it("returns an in-memory AgentStore when neither DATABASE_URL nor REDIS_URL is set", () => {
    const store = createAgentStore({});
    // Smoke: we can call registerFromTelegramUser without a real pool.
    expect(store).toBeInstanceOf(AgentStore);
  });
  it("returns an in-memory GroupStore when neither DATABASE_URL nor REDIS_URL is set", () => {
    const store = createGroupStore({});
    expect(store).toBeInstanceOf(GroupStore);
  });
  it("falls through to in-memory when DATABASE_URL is set but no pool is passed (defensive)", () => {
    // The factory should NOT throw or try to open a real connection when
    // the caller forgot to pass the pool. This is the path the test harness
    // hits: env may inherit DATABASE_URL from the orchestrator, but no
    // pool exists in-process.
    const store = createAgentStore({ DATABASE_URL: "postgres://x" });
    expect(store).toBeInstanceOf(AgentStore);
  });
});
