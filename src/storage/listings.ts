import type { PgPool } from "./db.js";

/**
 * Durable listing record (E2, E5T2). One per property an agent has created
 * via /create_listing. Backed by the `listings` table (see
 * src/storage/schema.sql). The store is backend-agnostic: the same class
 * fronts the PostgreSQL implementation and the in-memory fallback (used by
 * the test harness). Redis is NOT supported here — the project spec calls
 * for relational storage, and listings carry FKs to agents that don't
 * translate cleanly to a KV store.
 */
export interface ListingRecord {
  /** Server-assigned ID. PostgreSQL SERIAL. */
  id: number;
  /** Owning agent (FK to agents.telegram_id). */
  agent_id: number;
  title: string;
  description?: string;
  /** Price in cents to keep the column type stable regardless of currency. */
  price_cents?: number;
  bedrooms?: number;
  location?: string;
  /** ISO 8601 timestamp. */
  created_at: string;
}

/** Fields required to create a listing. `id` and `created_at` are filled by the store. */
export interface ListingInput {
  agent_id: number;
  title: string;
  description?: string;
  price_cents?: number;
  bedrooms?: number;
  location?: string;
}

/** Partial-update payload. Every field is optional; missing fields are untouched. */
export interface ListingUpdate {
  title?: string;
  description?: string;
  price_cents?: number;
  bedrooms?: number;
  location?: string;
}

/**
 * ListingStore — durable CRUD over the listings table. Two implementations:
 *   - PostgresListingStore: real SQL via pg.Pool (production)
 *   - InMemoryListingStore: Map-backed (test harness)
 * `createListingStore()` picks one based on env.
 */
export interface ListingStore {
  create(input: ListingInput): Promise<ListingRecord>;
  get(id: number): Promise<ListingRecord | undefined>;
  listByAgent(agentId: number): Promise<ListingRecord[]>;
  listForGroup(groupId: number): Promise<ListingRecord[]>;
  update(id: number, patch: ListingUpdate): Promise<ListingRecord | undefined>;
  delete(id: number): Promise<boolean>;
  /** Delete listings older than `retentionDays` days. Returns the row count. */
  purgeOlderThanDays(retentionDays: number): Promise<number>;
}

// --- PostgreSQL implementation ---------------------------------------------

class PostgresListingStore implements ListingStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: ListingInput): Promise<ListingRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO listings (agent_id, title, description, price_cents, bedrooms, location)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, agent_id, title, description, price_cents, bedrooms, location, created_at`,
      [
        input.agent_id,
        input.title,
        input.description ?? null,
        input.price_cents ?? null,
        input.bedrooms ?? null,
        input.location ?? null,
      ],
    );
    return rowToListing((rows as ListingRow[])[0]!);
  }

  async get(id: number): Promise<ListingRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT id, agent_id, title, description, price_cents, bedrooms, location, created_at FROM listings WHERE id = $1",
      [id],
    );
    const row = (rows as ListingRow[])[0];
    return row ? rowToListing(row) : undefined;
  }

  async listByAgent(agentId: number): Promise<ListingRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT id, agent_id, title, description, price_cents, bedrooms, location, created_at FROM listings WHERE agent_id = $1 ORDER BY created_at DESC",
      [agentId],
    );
    return (rows as ListingRow[]).map(rowToListing);
  }

  async listForGroup(groupId: number): Promise<ListingRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT l.id, l.agent_id, l.title, l.description, l.price_cents, l.bedrooms, l.location, l.created_at
       FROM listings l
       JOIN group_listings gl ON gl.listing_id = l.id
       WHERE gl.group_id = $1
       ORDER BY l.created_at DESC`,
      [groupId],
    );
    return (rows as ListingRow[]).map(rowToListing);
  }

  async update(id: number, patch: ListingUpdate): Promise<ListingRecord | undefined> {
    // Build a parameterised SET clause from the patch. Each supplied field
    // gets a fresh placeholder so we don't need to worry about a stale
    // value slipping through.
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (patch.title !== undefined) { sets.push(`title = $${i++}`); params.push(patch.title); }
    if (patch.description !== undefined) { sets.push(`description = $${i++}`); params.push(patch.description); }
    if (patch.price_cents !== undefined) { sets.push(`price_cents = $${i++}`); params.push(patch.price_cents); }
    if (patch.bedrooms !== undefined) { sets.push(`bedrooms = $${i++}`); params.push(patch.bedrooms); }
    if (patch.location !== undefined) { sets.push(`location = $${i++}`); params.push(patch.location); }
    if (sets.length === 0) return this.get(id);
    params.push(id);
    const { rows } = await this.pool.query(
      `UPDATE listings SET ${sets.join(", ")} WHERE id = $${i} RETURNING id, agent_id, title, description, price_cents, bedrooms, location, created_at`,
      params,
    );
    const row = (rows as ListingRow[])[0];
    return row ? rowToListing(row) : undefined;
  }

  async delete(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM listings WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM listings WHERE created_at < (NOW() - ($1::int * INTERVAL '1 day'))",
      [retentionDays],
    );
    return rowCount ?? 0;
  }
}

interface ListingRow {
  id: string | number;
  agent_id: string | number;
  title: string;
  description: string | null;
  price_cents: string | number | null;
  bedrooms: number | null;
  location: string | null;
  created_at: string;
}

function rowToListing(row: ListingRow): ListingRecord {
  return {
    id: Number(row.id),
    agent_id: Number(row.agent_id),
    title: row.title,
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.price_cents != null ? { price_cents: Number(row.price_cents) } : {}),
    ...(row.bedrooms != null ? { bedrooms: row.bedrooms } : {}),
    ...(row.location != null ? { location: row.location } : {}),
    created_at: row.created_at,
  };
}

// --- In-memory implementation -----------------------------------------------

class InMemoryListingStore implements ListingStore {
  private nextId = 1;
  private rows = new Map<number, ListingRecord>();
  /** group_id -> listing_ids (the `group_listings` join table, in-memory). */
  private groupLinks = new Map<number, Set<number>>();

  async create(input: ListingInput): Promise<ListingRecord> {
    const record: ListingRecord = {
      id: this.nextId++,
      agent_id: input.agent_id,
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.price_cents !== undefined ? { price_cents: input.price_cents } : {}),
      ...(input.bedrooms !== undefined ? { bedrooms: input.bedrooms } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      created_at: new Date().toISOString(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  async get(id: number): Promise<ListingRecord | undefined> {
    return this.rows.get(id);
  }

  async listByAgent(agentId: number): Promise<ListingRecord[]> {
    return [...this.rows.values()].filter((l) => l.agent_id === agentId).sort(byCreatedDesc);
  }

  async listForGroup(groupId: number): Promise<ListingRecord[]> {
    const ids = this.groupLinks.get(groupId);
    if (!ids) return [];
    const out: ListingRecord[] = [];
    for (const id of ids) {
      const r = this.rows.get(id);
      if (r) out.push(r);
    }
    return out.sort(byCreatedDesc);
  }

  async update(id: number, patch: ListingUpdate): Promise<ListingRecord | undefined> {
    const existing = this.rows.get(id);
    if (!existing) return undefined;
    const next: ListingRecord = { ...existing, ...patch };
    this.rows.set(id, next);
    return next;
  }

  async delete(id: number): Promise<boolean> {
    const had = this.rows.delete(id);
    for (const set of this.groupLinks.values()) set.delete(id);
    return had;
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let count = 0;
    for (const [id, r] of this.rows) {
      if (new Date(r.created_at).getTime() < cutoff) {
        this.rows.delete(id);
        for (const set of this.groupLinks.values()) set.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Test-only: link a listing to a group (mirrors the `group_listings` insert). */
  _linkGroup(listingId: number, groupId: number) {
    let set = this.groupLinks.get(groupId);
    if (!set) { set = new Set(); this.groupLinks.set(groupId, set); }
    set.add(listingId);
  }
}

function byCreatedDesc(a: ListingRecord, b: ListingRecord): number {
  // Newest first by created_at, with id desc as a stable tiebreaker so two
  // records created in the same millisecond don't reorder unpredictably.
  return b.created_at.localeCompare(a.created_at) || b.id - a.id;
}

// --- Factory ----------------------------------------------------------------

/**
 * createListingStore — pick the right implementation. PostgreSQL when
 * DATABASE_URL is set and a pool is provided; in-memory otherwise (the
 * test harness).
 */
export function createListingStore(
  env: { DATABASE_URL?: string } = process.env,
  db: PgPool | null = null,
): ListingStore {
  if (env.DATABASE_URL && db) return new PostgresListingStore(db);
  return new InMemoryListingStore();
}
