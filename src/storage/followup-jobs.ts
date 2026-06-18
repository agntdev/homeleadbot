import type { PgPool } from "./db.js";

/**
 * Follow-up job record (E4T3, E5T2). One row per scheduled nudge the bot
 * needs to send. The scheduler scans for `status='pending' AND
 * scheduled_at <= NOW()` and dispatches them. status='sent' rows stay
 * around for audit; status='cancelled' rows are leaves the scheduler
 * alone. Retention is bounded by the per-store purge method below.
 */
export interface FollowupJobRecord {
  id: number;
  lead_id: number;
  /** ISO 8601 timestamp; the scheduler dispatches when NOW() >= this. */
  scheduled_at: string;
  /** "pending" | "sent" | "cancelled". Defaults to "pending". */
  status: string;
  /** ISO 8601 timestamp when the job was actually sent (status='sent'). */
  sent_at?: string;
  /** ISO 8601 timestamp when the row was created. */
  created_at: string;
}

export interface FollowupJobInput {
  lead_id: number;
  scheduled_at: string;
  status?: string;
}

export interface FollowupStore {
  schedule(input: FollowupJobInput): Promise<FollowupJobRecord>;
  get(id: number): Promise<FollowupJobRecord | undefined>;
  listPendingDue(beforeIso: string): Promise<FollowupJobRecord[]>;
  listByLead(leadId: number): Promise<FollowupJobRecord[]>;
  markSent(id: number, sentAtIso: string): Promise<FollowupJobRecord | undefined>;
  cancel(id: number): Promise<FollowupJobRecord | undefined>;
  purgeOlderThanDays(retentionDays: number): Promise<number>;
}

// --- PostgreSQL implementation ---------------------------------------------

class PostgresFollowupStore implements FollowupStore {
  constructor(private readonly pool: PgPool) {}

  async schedule(input: FollowupJobInput): Promise<FollowupJobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO followup_jobs (lead_id, scheduled_at, status)
       VALUES ($1, $2, COALESCE($3, 'pending'))
       RETURNING id, lead_id, scheduled_at, status, sent_at, created_at`,
      [input.lead_id, input.scheduled_at, input.status ?? null],
    );
    return rowToJob((rows as FollowupRow[])[0]!);
  }

  async get(id: number): Promise<FollowupJobRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT id, lead_id, scheduled_at, status, sent_at, created_at FROM followup_jobs WHERE id = $1",
      [id],
    );
    const row = (rows as FollowupRow[])[0];
    return row ? rowToJob(row) : undefined;
  }

  async listPendingDue(beforeIso: string): Promise<FollowupJobRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT id, lead_id, scheduled_at, status, sent_at, created_at FROM followup_jobs WHERE status = 'pending' AND scheduled_at <= $1 ORDER BY scheduled_at ASC",
      [beforeIso],
    );
    return (rows as FollowupRow[]).map(rowToJob);
  }

  async listByLead(leadId: number): Promise<FollowupJobRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT id, lead_id, scheduled_at, status, sent_at, created_at FROM followup_jobs WHERE lead_id = $1 ORDER BY scheduled_at ASC",
      [leadId],
    );
    return (rows as FollowupRow[]).map(rowToJob);
  }

  async markSent(id: number, sentAtIso: string): Promise<FollowupJobRecord | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE followup_jobs SET status = 'sent', sent_at = $1
       WHERE id = $2
       RETURNING id, lead_id, scheduled_at, status, sent_at, created_at`,
      [sentAtIso, id],
    );
    const row = (rows as FollowupRow[])[0];
    return row ? rowToJob(row) : undefined;
  }

  async cancel(id: number): Promise<FollowupJobRecord | undefined> {
    const { rows } = await this.pool.query(
      `UPDATE followup_jobs SET status = 'cancelled'
       WHERE id = $1
       RETURNING id, lead_id, scheduled_at, status, sent_at, created_at`,
      [id],
    );
    const row = (rows as FollowupRow[])[0];
    return row ? rowToJob(row) : undefined;
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    // Purge sent + cancelled jobs older than the retention window. Pending
    // jobs are kept regardless (they still need to fire).
    const { rowCount } = await this.pool.query(
      `DELETE FROM followup_jobs
       WHERE status <> 'pending'
         AND created_at < (NOW() - ($1::int * INTERVAL '1 day'))`,
      [retentionDays],
    );
    return rowCount ?? 0;
  }
}

interface FollowupRow {
  id: string | number;
  lead_id: string | number;
  scheduled_at: string;
  status: string;
  sent_at: string | null;
  created_at: string;
}

function rowToJob(row: FollowupRow): FollowupJobRecord {
  return {
    id: Number(row.id),
    lead_id: Number(row.lead_id),
    scheduled_at: row.scheduled_at,
    status: row.status,
    ...(row.sent_at ? { sent_at: row.sent_at } : {}),
    created_at: row.created_at,
  };
}

// --- In-memory implementation -----------------------------------------------

class InMemoryFollowupStore implements FollowupStore {
  private nextId = 1;
  private rows = new Map<number, FollowupJobRecord>();

  async schedule(input: FollowupJobInput): Promise<FollowupJobRecord> {
    const record: FollowupJobRecord = {
      id: this.nextId++,
      lead_id: input.lead_id,
      scheduled_at: input.scheduled_at,
      status: input.status ?? "pending",
      created_at: new Date().toISOString(),
    };
    this.rows.set(record.id, record);
    return record;
  }

  async get(id: number): Promise<FollowupJobRecord | undefined> {
    return this.rows.get(id);
  }

  async listPendingDue(beforeIso: string): Promise<FollowupJobRecord[]> {
    return [...this.rows.values()]
      .filter((j) => j.status === "pending" && j.scheduled_at <= beforeIso)
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  }

  async listByLead(leadId: number): Promise<FollowupJobRecord[]> {
    return [...this.rows.values()].filter((j) => j.lead_id === leadId).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  }

  async markSent(id: number, sentAtIso: string): Promise<FollowupJobRecord | undefined> {
    const j = this.rows.get(id);
    if (!j) return undefined;
    const next = { ...j, status: "sent", sent_at: sentAtIso };
    this.rows.set(id, next);
    return next;
  }

  async cancel(id: number): Promise<FollowupJobRecord | undefined> {
    const j = this.rows.get(id);
    if (!j) return undefined;
    const next = { ...j, status: "cancelled" };
    this.rows.set(id, next);
    return next;
  }

  async purgeOlderThanDays(retentionDays: number): Promise<number> {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let count = 0;
    for (const [id, j] of this.rows) {
      if (j.status !== "pending" && new Date(j.created_at).getTime() < cutoff) {
        this.rows.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Test-only: rewrite created_at on a row so the purge can be exercised. */
  _setCreatedAt(id: number, iso: string) {
    const j = this.rows.get(id);
    if (j) this.rows.set(id, { ...j, created_at: iso });
  }
}

export function createFollowupStore(
  env: { DATABASE_URL?: string } = process.env,
  db: PgPool | null = null,
): FollowupStore {
  if (env.DATABASE_URL && db) return new PostgresFollowupStore(db);
  return new InMemoryFollowupStore();
}
