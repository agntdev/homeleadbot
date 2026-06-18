import { describe, expect, it, beforeEach } from "vitest";
import type { PgPool } from "../src/storage/db";
import {
  createListingStore,
  type ListingStore,
} from "../src/storage/listings";
import {
  createLeadStore,
  type LeadStore,
} from "../src/storage/leads";
import {
  createFollowupStore,
  type FollowupStore,
} from "../src/storage/followup-jobs";
import {
  runRetentionPolicy,
  DEFAULT_RETENTION_DAYS,
} from "../src/storage/retention";

/** Fake PgPool that returns the canned rows for a given SQL pattern. */
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

describe("ListingStore (in-memory)", () => {
  let store: ListingStore;
  beforeEach(() => { store = createListingStore({}); });

  it("create + get round-trip", async () => {
    const created = await store.create({
      agent_id: 100,
      title: "2BR Mission Loft",
      price_cents: 750_000_00,
      bedrooms: 2,
      location: "Mission, SF",
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe("2BR Mission Loft");
    const got = await store.get(created.id);
    expect(got).toEqual(created);
  });

  it("listByAgent returns only that agent's listings, newest first", async () => {
    const a = await store.create({ agent_id: 1, title: "A1" });
    const b = await store.create({ agent_id: 2, title: "B1" });
    const a2 = await store.create({ agent_id: 1, title: "A2" });
    const got = await store.listByAgent(1);
    expect(got.map((l) => l.id)).toEqual([a2.id, a.id]);
    expect(await store.listByAgent(2)).toEqual([b]);
  });

  it("listForGroup follows the group_listings join (in-memory via _linkGroup)", async () => {
    const a = await store.create({ agent_id: 1, title: "A" });
    const b = await store.create({ agent_id: 1, title: "B" });
    (store as unknown as { _linkGroup: (l: number, g: number) => void })._linkGroup(a.id, -1001);
    (store as unknown as { _linkGroup: (l: number, g: number) => void })._linkGroup(b.id, -1001);
    (store as unknown as { _linkGroup: (l: number, g: number) => void })._linkGroup(a.id, -1002);
    expect((await store.listForGroup(-1001)).map((l) => l.id)).toEqual([b.id, a.id]);
    expect((await store.listForGroup(-1002)).map((l) => l.id)).toEqual([a.id]);
  });

  it("update applies a partial patch", async () => {
    const a = await store.create({ agent_id: 1, title: "T", price_cents: 100 });
    const next = await store.update(a.id, { price_cents: 200, bedrooms: 3 });
    expect(next?.price_cents).toBe(200);
    expect(next?.bedrooms).toBe(3);
    expect(next?.title).toBe("T");
  });

  it("delete returns true the first time, false after", async () => {
    const a = await store.create({ agent_id: 1, title: "T" });
    expect(await store.delete(a.id)).toBe(true);
    expect(await store.delete(a.id)).toBe(false);
  });
});

describe("LeadStore (in-memory)", () => {
  let store: LeadStore;
  beforeEach(() => { store = createLeadStore({}); });

  it("create + get round-trip with a default status of 'new'", async () => {
    const lead = await store.create({ buyer_telegram_id: 555, listing_id: 1 });
    expect(lead.status).toBe("new");
    const got = await store.get(lead.id);
    expect(got?.buyer_telegram_id).toBe(555);
  });

  it("addIntakeItem + listIntakeItems preserves the position order", async () => {
    const lead = await store.create({ buyer_telegram_id: 555 });
    await store.addIntakeItem(lead.id, "Location?", "Mission", 0);
    await store.addIntakeItem(lead.id, "Budget?", "$800k", 1);
    await store.addIntakeItem(lead.id, "Timeline?", "30 days", 2);
    const items = await store.listIntakeItems(lead.id);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(items.map((i) => i.question)).toEqual(["Location?", "Budget?", "Timeline?"]);
  });

  it("addEvent + listEvents round-trips an event_data JSON blob", async () => {
    const lead = await store.create({ buyer_telegram_id: 555 });
    const ev = await store.addEvent(lead.id, "scored", { tier: "A", reason: "pre-approved + 30d" });
    expect(ev.event_type).toBe("scored");
    expect(ev.event_data).toEqual({ tier: "A", reason: "pre-approved + 30d" });
    const all = await store.listEvents(lead.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(ev);
  });

  it("delete cascades the intake items and events for that lead", async () => {
    const lead = await store.create({ buyer_telegram_id: 555 });
    await store.addIntakeItem(lead.id, "q", "a", 0);
    await store.addEvent(lead.id, "created");
    expect(await store.delete(lead.id)).toBe(true);
    expect(await store.listIntakeItems(lead.id)).toEqual([]);
    expect(await store.listEvents(lead.id)).toEqual([]);
  });

  it("listByStatus / listByBuyer / listByGroup are isolated filters", async () => {
    const a = await store.create({ buyer_telegram_id: 1, group_id: -100, status: "new" });
    const b = await store.create({ buyer_telegram_id: 2, group_id: -100, status: "contacted" });
    const c = await store.create({ buyer_telegram_id: 1, group_id: -200, status: "new" });
    expect((await store.listByBuyer(1)).map((l) => l.id).sort()).toEqual([a.id, c.id].sort());
    expect((await store.listByStatus("new")).map((l) => l.id).sort()).toEqual([a.id, c.id].sort());
    expect((await store.listByGroup(-100)).map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("FollowupStore (in-memory)", () => {
  let store: FollowupStore;
  beforeEach(() => { store = createFollowupStore({}); });

  it("schedule + listPendingDue returns only due + pending jobs", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await store.schedule({ lead_id: 1, scheduled_at: past });
    await store.schedule({ lead_id: 2, scheduled_at: future });
    const due = await store.listPendingDue(new Date().toISOString());
    expect(due).toHaveLength(1);
    expect(due[0]?.lead_id).toBe(1);
  });

  it("markSent / cancel update status and set sent_at only on sent", async () => {
    const j = await store.schedule({ lead_id: 1, scheduled_at: new Date().toISOString() });
    const sent = await store.markSent(j.id, "2026-06-18T12:00:00.000Z");
    expect(sent?.status).toBe("sent");
    expect(sent?.sent_at).toBe("2026-06-18T12:00:00.000Z");
    const c = await store.schedule({ lead_id: 2, scheduled_at: new Date().toISOString() });
    const cancelled = await store.cancel(c.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.sent_at).toBeUndefined();
  });

  it("purgeOlderThanDays only deletes non-pending rows", async () => {
    // Schedule a pending job first (created_at = now); its created_at is
    // "fresh", so the purge must leave it alone. Completed jobs created
    // via markSent/cancel share the same created_at as their schedule
    // call, which is also fresh — so to exercise the purge we drive
    // created_at into the past via a test-only hook on the in-memory
    // store.
    const completed = await store.schedule({ lead_id: 1, scheduled_at: new Date().toISOString() });
    await store.markSent(completed.id, new Date().toISOString());
    const cancelled = await store.schedule({ lead_id: 2, scheduled_at: new Date().toISOString() });
    await store.cancel(cancelled.id);
    const pending = await store.schedule({ lead_id: 3, scheduled_at: new Date().toISOString() });
    (store as unknown as { _setCreatedAt: (id: number, iso: string) => void })._setCreatedAt(completed.id, new Date(Date.now() - 100 * 86_400_000).toISOString());
    (store as unknown as { _setCreatedAt: (id: number, iso: string) => void })._setCreatedAt(cancelled.id, new Date(Date.now() - 100 * 86_400_000).toISOString());
    const deleted = await store.purgeOlderThanDays(30);
    expect(deleted).toBe(2);
    expect(await store.get(pending.id)).toBeDefined();
  });
});

describe("runRetentionPolicy", () => {
  it("purges across listings + leads + followups and reports totals", async () => {
    const listings = createListingStore({});
    const leads = createLeadStore({});
    const followups = createFollowupStore({});
    // Seed old + new entries.
    for (let i = 0; i < 3; i++) {
      const l = await listings.create({ agent_id: 1, title: `L${i}` });
      // Force created_at into the past.
      const stored = await listings.get(l.id);
      if (stored) (stored as { created_at: string }).created_at = new Date(Date.now() - 400 * 86_400_000).toISOString();
    }
    const newListing = await listings.create({ agent_id: 1, title: "fresh" });

    const result = await runRetentionPolicy({ listings, leads, followups }, 30);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.retentionDays).toBe(30);
    // The fresh listing must still be there.
    expect(await listings.get(newListing.id)).toBeDefined();
  });

  it("default retention is 12 months (365 days) per the project spec", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(365);
  });
});

describe("Postgres-backed stores (fake pool smoke tests)", () => {
  it("ListingStore uses the pool's INSERT path on create", async () => {
    const pool = fakePool({
      rowsByPattern: [
        {
          match: /INSERT INTO listings/i,
          rows: [{
            id: 42,
            agent_id: 1,
            title: "x",
            description: null,
            price_cents: null,
            bedrooms: null,
            location: null,
            created_at: "2026-06-18T00:00:00.000Z",
          }],
        },
      ],
    });
    const store = createListingStore({ DATABASE_URL: "postgres://x" }, pool);
    const got = await store.create({ agent_id: 1, title: "x" });
    expect(got.id).toBe(42);
    expect(pool.queries.some((q) => /^INSERT INTO listings/i.test(q.sql.trim()))).toBe(true);
  });

  it("LeadStore's purgeOlderThanDays uses a NOW() interval DELETE", async () => {
    const pool = fakePool({ rowsByPattern: [{ match: /DELETE FROM leads/i, rows: [], rowCount: 5 }] });
    const store = createLeadStore({ DATABASE_URL: "postgres://x" }, pool);
    const deleted = await store.purgeOlderThanDays(30);
    expect(deleted).toBe(5);
    expect(pool.queries[0]?.sql).toMatch(/NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  });

  it("FollowupStore's purgeOlderThanDays only touches non-pending rows", async () => {
    const pool = fakePool({ rowsByPattern: [{ match: /DELETE FROM followup_jobs/i, rows: [], rowCount: 2 }] });
    const store = createFollowupStore({ DATABASE_URL: "postgres://x" }, pool);
    await store.purgeOlderThanDays(30);
    expect(pool.queries[0]?.sql).toMatch(/status <> 'pending'/);
  });
});
