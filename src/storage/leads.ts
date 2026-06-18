import type { PgPool } from "./db.js";

/**
 * Lead + intake + event records (E3, E5T2). One Lead per captured buyer
 * interest (from the "I'm interested" button on a listing, or a direct
 * message). LeadIntakeItem records hold the structured Q/A from the
 * intake flow (location, budget, bedrooms, timeline, pre-approval).
 * LeadEvent records are an append-only audit log of what happened to a
 * lead over its lifecycle (created, scored, contacted, follow-up sent,
 * etc.). All three are stored together because the lead and its history
 * are usually read/written as a unit.
 */
export interface LeadRecord {
  /** Server-assigned ID. PostgreSQL SERIAL. */
  id: number;
  /** Listing that originated the lead, if any (FK to listings.id). */
  listing_id?: number;
  /** Telegram group the lead was captured from, if any (FK to groups.group_id). */
  group_id?: number;
  /** Telegram user ID of the buyer. Required. */
  buyer_telegram_id: number;
  buyer_username?: string;
  buyer_display_name?: string;
  /** Lifecycle status. Defaults to "new". */
  status: string;
  /** A / B / C lead tier (set by E3T2 scoring). */
  score?: string;
  /** ISO 8601 timestamp. */
  created_at: string;
  last_contacted_at?: string;
}

export interface LeadInput {
  listing_id?: number;
  group_id?: number;
  buyer_telegram_id: number;
  buyer_username?: string;
  buyer_display_name?: string;
  status?: string;
  score?: string;
}

export interface LeadUpdate {
  status?: string;
  score?: string;
  last_contacted_at?: string;
}

export interface LeadIntakeItemRecord {
  id: number;
  lead_id: number;
  question: string;
  answer: string;
  position: number;
}

export interface LeadEventRecord {
  id: number;
  lead_id: number;
  event_type: string;
  /** Free-form JSON blob (stored as JSONB in Postgres). */
  event_data?: unknown;
  created_at: string;
}

// --- LeadStore interface ----------------------------------------------------

export interface LeadStore {
  create(input: LeadInput): Promise<LeadRecord>;
  get(id: number): Promise<LeadRecord | undefined>;
  listByBuyer(buyerTelegramId: number): Promise<LeadRecord[]>;
  listByAgent(agentId: number): Promise<LeadRecord[]>;
  listByGroup(groupId: number): Promise<LeadRecord[]>;
  listByStatus(status: string): Promise<LeadRecord[]>;
  update(id: number, patch: LeadUpdate): Promise<LeadRecord | undefined>;
  delete(id: number): Promise<boolean>;
  purgeOlderThanDays(retentionDays: number): Promise<number>;

  // Intake items (one per intake question answered).
  addIntakeItem(leadId: number, question: string, answer: string, position: number): Promise<LeadIntakeItemRecord>;
  listIntakeItems(leadId: number): Promise<LeadIntakeItemRecord[]>;

  // Events (append-only audit log).
  addEvent(leadId: number, eventType: string, eventData?: unknown): Promise<LeadEventRecord>;
  listEvents(leadId: number): Promise<LeadEventRecord[]>;
}

// --- PostgreSQL implementation ---------------------------------------------

class PostgresLeadStore implements LeadStore {
  constructor(private readonly pool: PgPool) {}

  async create(input: LeadInput): Promise<LeadRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO leads (listing_id, group_id, buyer_telegram_id, buyer_username, buyer_display_name, status, score)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'new'), $7)
       RETURNING id, listing_id, group_id, buyer_telegram_id, buyer_username, buyer_display_name, status, score, created_at, last_contacted_at`,
      [
        input.listing_id ?? null,
        input.group_id ?? null,
        input.buyer_telegram_id,
        input.buyer_username ?? null,
        input.buyer_display_name ?? null,
        input.status ?? null,
        input.score ?? null,
      ],
    );
    return rowToLead((rows as LeadRow[])[0]!);
  }

  async get(id: number): Promise<LeadRecord | undefined> {
    const { rows } = await this.pool.query(LEAD_COLS, [id]);
    const row = (rows as LeadRow[])[0];
    return row ? rowToLead(row) : undefined;
  }

  async listByBuyer(buyerTelegramId: number): Promise<LeadRecord[]> {
    const { rows } = await this.pool.query(
      `${LEAD_COLS_BASE} WHERE buyer_telegram_id = $1 ORDER BY created_at DESC`,
      [buyerTelegramId],
    );
    return (rows as LeadRow[]).map(rowToLead);
  }

  async listByAgent(agentId: number): Promise<LeadRecord[]> {
    // Joins through listings so we can filter by the owning agent.
    const { rows } = await this.pool.query(
      `${LEAD_COLS_BASE} l
       JOIN listings ls ON ls.id = l.listing_id
       WHERE ls.agent_id = $1
       ORDER BY l.created_at DESC`,
      [agentId],
    );
    return (rows as LeadRow[]).map(rowToLead);
  }

  async listByGroup(groupId: number): Promise<LeadRecord[]> {
    const { rows } = await this.pool.query(
      `${LEAD_COLS_BASE} WHERE group_id = $1 ORDER BY created_at DESC`,
      [groupId],
    );
    return (rows as LeadRow[]).map(rowToLead);
  }

  async listByStatus(status: string): Promise<LeadRecord[]> {
    const { rows } = await this.pool.query(
      `${LEAD_COLS_BASE} WHERE status = $1 ORDER BY created_at DESC`,
      [status],
    );
    return (rows as LeadRow[]).map(rowToLead);
  }

  async update(id: number, patch: LeadUpdate): Promise<LeadRecord | undefined> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) { sets.push(`status = $${i++}`); params.push(patch.status); }
    if (patch.score !== undefined) { sets.push(`score = $${i++}`); params.push(patch.score); }
    if (patch.last_contacted_at !== undefined) { sets.push(`last_contacted_at = $${i++}`); params.push(patch.last_contacted_at); }
    if (sets.length === 0) return this.get(id);
    params.push(id);
    const { rows } = await this.pool.query(
      `UPDATE leads SET ${sets.join(", ")} WHERE id = $${i} ${LEAD_RETURNING}`,
      params,
    );
    const row = (rows as LeadRow[])[0];
    return row ? rowToLead(row) : undefined;
  }

  async delete(id: number): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM leads WHERE id = $1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      "DELETE FROM leads WHERE created_at < (NOW() - ($1::int * INTERVAL '1 day'))",
      [retentionDays],
    );
    return rowCount ?? 0;
  }

  async addIntakeItem(leadId: number, question: string, answer: string, position: number) {
    const { rows } = await this.pool.query(
      `INSERT INTO lead_intake_items (lead_id, question, answer, position)
       VALUES ($1, $2, $3, $4)
       RETURNING id, lead_id, question, answer, position`,
      [leadId, question, answer, position],
    );
    return rowToIntakeItem((rows as IntakeRow[])[0]!);
  }

  async listIntakeItems(leadId: number) {
    const { rows } = await this.pool.query(
      "SELECT id, lead_id, question, answer, position FROM lead_intake_items WHERE lead_id = $1 ORDER BY position ASC, id ASC",
      [leadId],
    );
    return (rows as IntakeRow[]).map(rowToIntakeItem);
  }

  async addEvent(leadId: number, eventType: string, eventData?: unknown) {
    const { rows } = await this.pool.query(
      `INSERT INTO lead_events (lead_id, event_type, event_data)
       VALUES ($1, $2, $3::jsonb)
       RETURNING id, lead_id, event_type, event_data, created_at`,
      [leadId, eventType, eventData === undefined ? null : JSON.stringify(eventData)],
    );
    return rowToEvent((rows as EventRow[])[0]!);
  }

  async listEvents(leadId: number) {
    const { rows } = await this.pool.query(
      "SELECT id, lead_id, event_type, event_data, created_at FROM lead_events WHERE lead_id = $1 ORDER BY created_at ASC, id ASC",
      [leadId],
    );
    return (rows as EventRow[]).map(rowToEvent);
  }
}

const LEAD_COLS_BASE = `SELECT l.id, l.listing_id, l.group_id, l.buyer_telegram_id,
       l.buyer_username, l.buyer_display_name, l.status, l.score, l.created_at, l.last_contacted_at FROM leads l`;
const LEAD_RETURNING = `RETURNING id, listing_id, group_id, buyer_telegram_id, buyer_username, buyer_display_name, status, score, created_at, last_contacted_at`;
const LEAD_COLS = `${LEAD_COLS_BASE} WHERE l.id = $1`;

interface LeadRow {
  id: string | number;
  listing_id: string | number | null;
  group_id: string | number | null;
  buyer_telegram_id: string | number;
  buyer_username: string | null;
  buyer_display_name: string | null;
  status: string;
  score: string | null;
  created_at: string;
  last_contacted_at: string | null;
}

function rowToLead(row: LeadRow): LeadRecord {
  return {
    id: Number(row.id),
    ...(row.listing_id != null ? { listing_id: Number(row.listing_id) } : {}),
    ...(row.group_id != null ? { group_id: Number(row.group_id) } : {}),
    buyer_telegram_id: Number(row.buyer_telegram_id),
    ...(row.buyer_username ? { buyer_username: row.buyer_username } : {}),
    ...(row.buyer_display_name ? { buyer_display_name: row.buyer_display_name } : {}),
    status: row.status,
    ...(row.score ? { score: row.score } : {}),
    created_at: row.created_at,
    ...(row.last_contacted_at ? { last_contacted_at: row.last_contacted_at } : {}),
  };
}

interface IntakeRow {
  id: string | number;
  lead_id: string | number;
  question: string;
  answer: string;
  position: number;
}

function rowToIntakeItem(row: IntakeRow): LeadIntakeItemRecord {
  return {
    id: Number(row.id),
    lead_id: Number(row.lead_id),
    question: row.question,
    answer: row.answer,
    position: row.position,
  };
}

interface EventRow {
  id: string | number;
  lead_id: string | number;
  event_type: string;
  event_data: string | null;
  created_at: string;
}

function rowToEvent(row: EventRow): LeadEventRecord {
  let data: unknown;
  if (row.event_data != null) {
    try { data = JSON.parse(row.event_data); } catch { data = row.event_data; }
  }
  return {
    id: Number(row.id),
    lead_id: Number(row.lead_id),
    event_type: row.event_type,
    ...(data !== undefined ? { event_data: data } : {}),
    created_at: row.created_at,
  };
}

// --- In-memory implementation -----------------------------------------------

class InMemoryLeadStore implements LeadStore {
  private nextLeadId = 1;
  private nextIntakeId = 1;
  private nextEventId = 1;
  private leads = new Map<number, LeadRecord>();
  private intake = new Map<number, LeadIntakeItemRecord>();
  private events = new Map<number, LeadEventRecord>();
  /** listing_id -> agent_id (so listByAgent can resolve leads → owning agent). */
  private listingOwner = new Map<number, number>();

  /** Test-only: register the agent that owns a listing (used by listByAgent). */
  _registerListingOwner(listingId: number, agentId: number) {
    this.listingOwner.set(listingId, agentId);
  }

  async create(input: LeadInput): Promise<LeadRecord> {
    const record: LeadRecord = {
      id: this.nextLeadId++,
      ...(input.listing_id !== undefined ? { listing_id: input.listing_id } : {}),
      ...(input.group_id !== undefined ? { group_id: input.group_id } : {}),
      buyer_telegram_id: input.buyer_telegram_id,
      ...(input.buyer_username !== undefined ? { buyer_username: input.buyer_username } : {}),
      ...(input.buyer_display_name !== undefined ? { buyer_display_name: input.buyer_display_name } : {}),
      status: input.status ?? "new",
      ...(input.score !== undefined ? { score: input.score } : {}),
      created_at: new Date().toISOString(),
    };
    this.leads.set(record.id, record);
    return record;
  }

  async get(id: number): Promise<LeadRecord | undefined> {
    return this.leads.get(id);
  }

  async listByBuyer(buyerTelegramId: number): Promise<LeadRecord[]> {
    return [...this.leads.values()].filter((l) => l.buyer_telegram_id === buyerTelegramId).sort(byCreatedDesc);
  }
  async listByAgent(agentId: number): Promise<LeadRecord[]> {
    const ownedListings = new Set<number>();
    for (const [lid, owner] of this.listingOwner) if (owner === agentId) ownedListings.add(lid);
    return [...this.leads.values()].filter((l) => l.listing_id !== undefined && ownedListings.has(l.listing_id)).sort(byCreatedDesc);
  }
  async listByGroup(groupId: number): Promise<LeadRecord[]> {
    return [...this.leads.values()].filter((l) => l.group_id === groupId).sort(byCreatedDesc);
  }
  async listByStatus(status: string): Promise<LeadRecord[]> {
    return [...this.leads.values()].filter((l) => l.status === status).sort(byCreatedDesc);
  }
  async update(id: number, patch: LeadUpdate): Promise<LeadRecord | undefined> {
    const existing = this.leads.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.leads.set(id, next);
    return next;
  }
  async delete(id: number): Promise<boolean> {
    const had = this.leads.delete(id);
    for (const [k, v] of this.intake) if (v.lead_id === id) this.intake.delete(k);
    for (const [k, v] of this.events) if (v.lead_id === id) this.events.delete(k);
    return had;
  }
  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let count = 0;
    for (const [id, r] of this.leads) {
      if (new Date(r.created_at).getTime() < cutoff) {
        this.leads.delete(id);
        count++;
      }
    }
    return count;
  }

  async addIntakeItem(leadId: number, question: string, answer: string, position: number) {
    const record: LeadIntakeItemRecord = {
      id: this.nextIntakeId++,
      lead_id: leadId,
      question,
      answer,
      position,
    };
    this.intake.set(record.id, record);
    return record;
  }
  async listIntakeItems(leadId: number): Promise<LeadIntakeItemRecord[]> {
    return [...this.intake.values()].filter((i) => i.lead_id === leadId).sort((a, b) => a.position - b.position || a.id - b.id);
  }

  async addEvent(leadId: number, eventType: string, eventData?: unknown): Promise<LeadEventRecord> {
    const record: LeadEventRecord = {
      id: this.nextEventId++,
      lead_id: leadId,
      event_type: eventType,
      ...(eventData !== undefined ? { event_data: eventData } : {}),
      created_at: new Date().toISOString(),
    };
    this.events.set(record.id, record);
    return record;
  }
  async listEvents(leadId: number): Promise<LeadEventRecord[]> {
    return [...this.events.values()].filter((e) => e.lead_id === leadId).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  }
}

function byCreatedDesc(a: LeadRecord, b: LeadRecord): number {
  return b.created_at.localeCompare(a.created_at);
}

// --- Factory ----------------------------------------------------------------

export function createLeadStore(
  env: { DATABASE_URL?: string } = process.env,
  db: PgPool | null = null,
): LeadStore {
  if (env.DATABASE_URL && db) return new PostgresLeadStore(db);
  return new InMemoryLeadStore();
}
