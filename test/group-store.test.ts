import { describe, expect, it, beforeEach } from "vitest";
import type { PgPool } from "../src/storage/db";
import { createGroupStore, type GroupStore } from "../src/storage/groups";

function fakePool(opts: {
  rowsByPattern?: Array<{ match: RegExp; rows: unknown[]; rowCount?: number }>;
} = {}): PgPool & { queries: Array<{ sql: string; params?: unknown[] }> } {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const rowsByPattern = opts.rowsByPattern ?? [];
  return {
    queries,
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      for (const r of rowsByPattern) {
        if (r.match.test(sql)) {
          return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    async end() { /* no-op */ },
  };
}

describe("GroupStore (in-memory) — E1T3 extensions", () => {
  let store: GroupStore;
  beforeEach(() => { store = createGroupStore({}); });

  it("registerGroup + claim round-trip a real title from the my_chat_member path", async () => {
    // E1T3 regression: the claim callback only carries the group_id in
    // its callback data, so the title has to come from somewhere else.
    // The my_chat_member handler calls registerGroup() to stash it; the
    // claim callback then pulls it via getGroupTitle().
    await store.registerGroup({ id: -1007777, type: "supergroup", title: "Bernal Heights" });
    const { claim, isNew } = await store.claim({ id: -1007777, type: "supergroup" }, 555);
    expect(isNew).toBe(true);
    expect(claim.group_title).toBe("Bernal Heights");
  });

  it("claim({ id, type }) without a title uses the previously registered title", async () => {
    await store.registerGroup({ id: -1007778, type: "group", title: "Inner Sunset" });
    const { claim } = await store.claim({ id: -1007778, type: "group" }, 555);
    expect(claim.group_title).toBe("Inner Sunset");
  });

  it("listByAgent returns only that agent's groups", async () => {
    await store.registerGroup({ id: -1009001, type: "group", title: "A" });
    await store.registerGroup({ id: -1009002, type: "group", title: "B" });
    await store.registerGroup({ id: -1009003, type: "group", title: "C" });
    await store.claim({ id: -1009001, type: "group" }, 1);
    await store.claim({ id: -1009002, type: "group" }, 1);
    await store.claim({ id: -1009003, type: "group" }, 2);
    const mine = await store.listByAgent(1);
    expect(mine.map((g) => g.group_id).sort()).toEqual([-1009001, -1009002]);
  });

  it("detach removes the claim; listByAgent no longer returns it", async () => {
    await store.registerGroup({ id: -1009004, type: "group", title: "X" });
    await store.claim({ id: -1009004, type: "group" }, 7);
    expect(await store.detach(-1009004)).toBe(true);
    expect(await store.detach(-1009004)).toBe(false);
    expect(await store.listByAgent(7)).toEqual([]);
  });

  it("updateTitle changes the title on both the claim and the stashed group meta", async () => {
    await store.registerGroup({ id: -1009005, type: "group", title: "Old" });
    await store.claim({ id: -1009005, type: "group" }, 7);
    const next = await store.updateTitle(-1009005, "Brand New");
    expect(next?.group_title).toBe("Brand New");
    expect(await store.getGroupTitle(-1009005)).toBe("Brand New");
  });

  it("updateTitle returns undefined for a group that isn't claimed", async () => {
    expect(await store.updateTitle(-1009999, "x")).toBeUndefined();
  });

  it("registerGroup does not blank a real title with a later undefined", async () => {
    await store.registerGroup({ id: -1009006, type: "group", title: "Original" });
    // A later my_chat_member without a title (e.g. channel post) must not
    // wipe the title we already stashed.
    await store.registerGroup({ id: -1009006, type: "group" });
    expect(await store.getGroupTitle(-1009006)).toBe("Original");
  });
});

describe("GroupStore (Postgres) — E1T3 SQL paths", () => {
  it("listByAgent joins group_claims + groups to surface the title", async () => {
    const pool = fakePool({
      rowsByPattern: [{
        match: /FROM group_claims gc/i,
        rows: [
          { group_id: -1007777, claimed_by: 1, claimed_at: "2026-06-18T00:00:00.000Z", title: "SOMA" },
          { group_id: -1007778, claimed_by: 1, claimed_at: "2026-06-18T00:00:01.000Z", title: null },
        ],
      }],
    });
    const store = createGroupStore({ DATABASE_URL: "postgres://x" }, pool);
    const got = await store.listByAgent(1);
    expect(got).toHaveLength(2);
    expect(got[0]?.group_title).toBe("SOMA");
    // Second row has no title — group_title is omitted (no `undefined` in
    // the returned object so the renderer can show the fallback).
    expect(got[1]?.group_title).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(got[1]!, "group_title")).toBe(false);
  });

  it("detach issues a single DELETE on group_claims", async () => {
    const pool = fakePool({ rowsByPattern: [{ match: /DELETE FROM group_claims/i, rows: [], rowCount: 1 }] });
    const store = createGroupStore({ DATABASE_URL: "postgres://x" }, pool);
    expect(await store.detach(-1009000)).toBe(true);
    expect(pool.queries[0]?.sql).toMatch(/DELETE FROM group_claims WHERE group_id = \$1/);
  });

  it("updateTitle updates both group_claims and the parent groups row", async () => {
    // First call: UPDATE group_claims (rowCount=1). Second call: UPDATE groups.
    // Third call (the post-update get): SELECT.
    const pool = fakePool({
      rowsByPattern: [
        { match: /UPDATE group_claims SET group_title/i, rows: [], rowCount: 1 },
        { match: /UPDATE groups SET title/i, rows: [], rowCount: 1 },
        { match: /FROM group_claims WHERE group_id/i, rows: [{ group_id: -1009000, group_title: "Renamed", claimed_by: 1, claimed_at: "2026-06-18T00:00:00.000Z" }] },
      ],
    });
    const store = createGroupStore({ DATABASE_URL: "postgres://x" }, pool);
    const next = await store.updateTitle(-1009000, "Renamed");
    expect(next?.group_title).toBe("Renamed");
    expect(pool.queries.some((q) => /UPDATE groups SET title/i.test(q.sql))).toBe(true);
  });
});
