import { createRequire } from "node:module";
import type { PgPool } from "./db.js";

/**
 * Durable group-claim record (E1T2, E1T3, E5T1). One per Telegram group
 * that an agent has claimed via the inline "Claim this group" button.
 * Keyed by Telegram group ID; lives in PostgreSQL (preferred) or in-memory
 * (test / dev). Source of truth for "who receives lead notifications for
 * this group" — used by E4T1 hot-lead routing and E4T3 follow-up routing.
 */
export interface GroupClaim {
  /** Telegram group (chat) ID — unique, immutable. The Redis key / Postgres PK. */
  group_id: number;
  /** Best group title we have at claim time. Updated on rename (E1T3). */
  group_title?: string;
  /** Telegram user ID of the claiming agent (FK to AgentRecord.telegram_id). */
  claimed_by: number;
  /** ISO 8601 timestamp of the claim. */
  claimed_at: string;
}

/** Minimal Telegram Chat shape we read from ctx.myChatMember.chat. */
export interface TelegramChatRef {
  id: number;
  type: string;
  title?: string;
}

/**
 * Internal group-meta record (the parent `groups` row in Postgres). Stashed
 * by the my_chat_member handler BEFORE the claim button is shown, so the
 * claim callback can attach a real title to the new claim — the button's
 * callback data only carries the group_id (Telegram limits callback_data
 * to 64 bytes, so we can't smuggle the title through).
 */
export interface GroupMeta {
  group_id: number;
  title?: string;
  type: string;
}

/**
 * GroupStore — durable CRUD over the group_claims + groups tables (or
 * in-memory equivalents). Two backends:
 *   - PostgresGroupStore: real SQL via pg.Pool (production)
 *   - InMemoryGroupStore: Map-backed (test harness)
 * `createGroupStore()` picks one based on env.
 */
export class GroupStore {
  /** Read a single group claim by Telegram group ID. Returns undefined if unclaimed. */
  async get(groupId: number): Promise<GroupClaim | undefined> { throw new Error("abstract"); }
  /** Check whether a group has been claimed. */
  async has(groupId: number): Promise<boolean> { throw new Error("abstract"); }
  /**
   * Claim a group on behalf of `claimedBy`. Looks up the title from the
   * pre-registered group meta (see `registerGroup`); falls back to the
   * title in the TelegramChatRef if the caller has one (the test harness
   * sometimes passes it directly). Returns the persisted claim and an
   * `isNew` flag (true if THIS call performed the claim, false if it was
   * a no-op because the group was already claimed).
   */
  async claim(chat: TelegramChatRef, claimedBy: number): Promise<{ claim: GroupClaim; isNew: boolean }> { throw new Error("abstract"); }
  /**
   * registerGroup — stash a group's meta (title + type) before the claim
   * button is shown. The my_chat_member handler in bot.ts calls this
   * right after detecting the bot was added. Safe to call repeatedly;
   * later calls only overwrite a non-null title (we don't want to blank
   * a real title with NULL).
   */
  async registerGroup(chat: TelegramChatRef): Promise<void> { throw new Error("abstract"); }
  /** Read the stashed title for a group. Returns undefined if not registered. */
  async getGroupTitle(groupId: number): Promise<string | undefined> { throw new Error("abstract"); }

  /** E1T3: every group the given agent has claimed. */
  async listByAgent(agentId: number): Promise<GroupClaim[]> { throw new Error("abstract"); }
  /** E1T3: remove the claim for the given group. Returns true if a claim was removed. */
  async detach(groupId: number): Promise<boolean> { throw new Error("abstract"); }
  /** E1T3: rename the local display title of a claimed group. */
  async updateTitle(groupId: number, title: string): Promise<GroupClaim | undefined> { throw new Error("abstract"); }
}

// --- PostgreSQL implementation ----------------------------------------------

class PostgresGroupStore extends GroupStore {
  constructor(private readonly pool: PgPool) { super(); }

  async get(groupId: number): Promise<GroupClaim | undefined> {
    const { rows } = await this.pool.query(
      "SELECT group_id, group_title, claimed_by, claimed_at FROM group_claims WHERE group_id = $1",
      [groupId],
    );
    const row = (rows as GroupClaimRow[])[0];
    return row ? rowToClaim(row) : undefined;
  }

  async has(groupId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM group_claims WHERE group_id = $1 LIMIT 1",
      [groupId],
    );
    return (rowCount ?? 0) > 0;
  }

  async registerGroup(chat: TelegramChatRef): Promise<void> {
    await this.pool.query(
      `INSERT INTO groups (group_id, title, type)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, groups.title),
         type  = COALESCE(EXCLUDED.type,  groups.type)`,
      [chat.id, chat.title ?? null, chat.type],
    );
  }

  async getGroupTitle(groupId: number): Promise<string | undefined> {
    const { rows } = await this.pool.query(
      "SELECT title FROM groups WHERE group_id = $1",
      [groupId],
    );
    const title = (rows as Array<{ title: string | null }>)[0]?.title;
    return title ?? undefined;
  }

  async claim(chat: TelegramChatRef, claimedBy: number): Promise<{ claim: GroupClaim; isNew: boolean }> {
    // If the caller didn't pass a title (the usual case from the claim
    // callback — only the group_id is in the callback data), look it up
    // from the pre-registered group meta.
    const title = chat.title ?? (await this.getGroupTitle(chat.id));
    const existing = await this.get(chat.id);
    if (existing) return { claim: existing, isNew: false };
    const claim: GroupClaim = {
      group_id: chat.id,
      ...(title ? { group_title: title } : {}),
      claimed_by: claimedBy,
      claimed_at: new Date().toISOString(),
    };
    // Upsert the parent groups row (idempotent — registerGroup may have
    // already done this with a different title). Then insert the claim.
    await this.pool.query(
      `INSERT INTO groups (group_id, title, type)
       VALUES ($1, $2, 'group')
       ON CONFLICT (group_id) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, groups.title)`,
      [claim.group_id, claim.group_title ?? null],
    );
    await this.pool.query(
      `INSERT INTO group_claims (group_id, claimed_by, claimed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id) DO NOTHING`,
      [claim.group_id, claim.claimed_by, claim.claimed_at],
    );
    return { claim, isNew: true };
  }

  async listByAgent(agentId: number): Promise<GroupClaim[]> {
    const { rows } = await this.pool.query(
      `SELECT gc.group_id, gc.claimed_by, gc.claimed_at, g.title
       FROM group_claims gc
       LEFT JOIN groups g ON g.group_id = gc.group_id
       WHERE gc.claimed_by = $1
       ORDER BY gc.claimed_at DESC`,
      [agentId],
    );
    return (rows as Array<GroupClaimRow & { title: string | null }>).map((r) => ({
      group_id: Number(r.group_id),
      ...(r.title ? { group_title: r.title } : {}),
      claimed_by: Number(r.claimed_by),
      claimed_at: r.claimed_at,
    }));
  }

  async detach(groupId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM group_claims WHERE group_id = $1", [groupId]);
    return (rowCount ?? 0) > 0;
  }

  async updateTitle(groupId: number, title: string): Promise<GroupClaim | undefined> {
    const { rowCount } = await this.pool.query(
      "UPDATE group_claims SET group_title = $1 WHERE group_id = $2",
      [title, groupId],
    );
    if ((rowCount ?? 0) === 0) return undefined;
    // Mirror the new title into the parent groups row so listings and
    // leads that reference this group see it too.
    await this.pool.query(
      "UPDATE groups SET title = $1 WHERE group_id = $2",
      [title, groupId],
    );
    return this.get(groupId);
  }
}

interface GroupClaimRow {
  group_id: string | number;
  group_title: string | null;
  claimed_by: string | number;
  claimed_at: string;
}

function rowToClaim(row: GroupClaimRow): GroupClaim {
  return {
    group_id: Number(row.group_id),
    ...(row.group_title ? { group_title: row.group_title } : {}),
    claimed_by: Number(row.claimed_by),
    claimed_at: row.claimed_at,
  };
}

// --- In-memory implementation -----------------------------------------------

class InMemoryGroupStore extends GroupStore {
  private claims = new Map<number, GroupClaim>();
  private meta = new Map<number, GroupMeta>();

  async get(groupId: number): Promise<GroupClaim | undefined> {
    return this.claims.get(groupId);
  }

  async has(groupId: number): Promise<boolean> {
    return this.claims.has(groupId);
  }

  async registerGroup(chat: TelegramChatRef): Promise<void> {
    const existing = this.meta.get(chat.id);
    const next: GroupMeta = {
      group_id: chat.id,
      type: chat.type,
      // Don't blank a real title with NULL — only overwrite if the new
      // value is non-null OR no value exists yet.
      ...(chat.title || !existing?.title ? (chat.title ? { title: chat.title } : {}) : { title: existing.title }),
    };
    this.meta.set(chat.id, next);
  }

  async getGroupTitle(groupId: number): Promise<string | undefined> {
    return this.meta.get(groupId)?.title;
  }

  async claim(chat: TelegramChatRef, claimedBy: number): Promise<{ claim: GroupClaim; isNew: boolean }> {
    const title = chat.title ?? (await this.getGroupTitle(chat.id));
    const existing = this.claims.get(chat.id);
    if (existing) return { claim: existing, isNew: false };
    const claim: GroupClaim = {
      group_id: chat.id,
      ...(title ? { group_title: title } : {}),
      claimed_by: claimedBy,
      claimed_at: new Date().toISOString(),
    };
    this.claims.set(chat.id, claim);
    if (title) {
      // Mirror to meta so subsequent listByAgent / renders can find it.
      const existingMeta = this.meta.get(chat.id);
      this.meta.set(chat.id, {
        group_id: chat.id,
        type: existingMeta?.type ?? "group",
        title,
      });
    }
    return { claim, isNew: true };
  }

  async listByAgent(agentId: number): Promise<GroupClaim[]> {
    return [...this.claims.values()].filter((c) => c.claimed_by === agentId);
  }

  async detach(groupId: number): Promise<boolean> {
    return this.claims.delete(groupId);
  }

  async updateTitle(groupId: number, title: string): Promise<GroupClaim | undefined> {
    const existing = this.claims.get(groupId);
    if (!existing) return undefined;
    const next: GroupClaim = { ...existing, group_title: title };
    this.claims.set(groupId, next);
    const meta = this.meta.get(groupId);
    if (meta) this.meta.set(groupId, { ...meta, title });
    return next;
  }
}

// --- Factory ----------------------------------------------------------------

/**
 * createGroupStore — pick the right implementation. PostgreSQL when
 * DATABASE_URL is set and a pool is provided; in-memory otherwise (the
 * test harness). Redis is NOT supported in this version — the project
 * spec calls for relational storage, and group claims carry FKs to
 * agents + listings that don't translate cleanly to a KV store.
 */
export function createGroupStore(
  env: { DATABASE_URL?: string } = process.env,
  db: PgPool | null = null,
): GroupStore {
  if (env.DATABASE_URL && db) return new PostgresGroupStore(db);
  return new InMemoryGroupStore();
}
