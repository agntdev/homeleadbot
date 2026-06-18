import { createRequire } from "node:module";
import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import {
  RedisSessionStorage,
  type RedisLike,
} from "../toolkit/session/redis.js";
import type { PgPool } from "./db.js";

/**
 * Durable group-claim record (E1T2, E5T1). One per Telegram group that an
 * agent has claimed via the inline "Claim this group" button. Keyed by
 * Telegram group ID; lives in PostgreSQL (preferred), Redis (legacy), or
 * in-memory (test / dev). Source of truth for "who receives lead
 * notifications for this group" — used by E4T1 hot-lead routing and
 * E4T3 follow-up routing.
 */
export interface GroupClaim {
  /** Telegram group (chat) ID — unique, immutable. The Redis key / Postgres PK. */
  group_id: number;
  /** Best group title we have at claim time. Updated on re-claim if title changed. */
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
 * GroupStore — durable key-value store keyed by Telegram group ID. The class
 * is backend-agnostic: the storage adapter is injected, so the same class
 * fronts the PostgreSQL, Redis, and in-memory implementations. The factory
 * `createGroupStore()` picks the backend.
 */
export class GroupStore {
  constructor(private readonly storage: StorageAdapter<GroupClaim>) {}

  /** Read a single group claim by Telegram group ID. Returns undefined if unclaimed. */
  async get(groupId: number): Promise<GroupClaim | undefined> {
    return this.storage.read(String(groupId));
  }

  /** Check whether a group has been claimed. */
  async has(groupId: number): Promise<boolean> {
    const v = await this.storage.read(String(groupId));
    return v !== undefined;
  }

  /**
   * Claim a group on behalf of `claimedBy` (a Telegram user ID). If the group
   * is already claimed, this is a no-op (the spec says "first admin to press
   * becomes the agent" — subsequent presses are ignored). Returns the
   * persisted claim and a flag indicating whether THIS call performed the
   * claim (true) or whether it was a no-op (false).
   */
  async claim(
    chat: TelegramChatRef,
    claimedBy: number,
  ): Promise<{ claim: GroupClaim; isNew: boolean }> {
    const existing = await this.get(chat.id);
    if (existing) return { claim: existing, isNew: false };
    const claim: GroupClaim = {
      group_id: chat.id,
      ...(chat.title ? { group_title: chat.title } : {}),
      claimed_by: claimedBy,
      claimed_at: new Date().toISOString(),
    };
    await this.storage.write(String(claim.group_id), claim);
    return { claim, isNew: true };
  }
}

/**
 * PostgresGroupAdapter — grammY StorageAdapter backed by the `group_claims`
 * table. Also inserts a row into `groups` on write so the FK from
 * group_claims.group_id → groups.group_id is satisfied (E5T1 schema).
 */
class PostgresGroupAdapter implements StorageAdapter<GroupClaim> {
  constructor(private readonly pool: PgPool) {}

  async read(key: string): Promise<GroupClaim | undefined> {
    const { rows } = await this.pool.query(
      "SELECT group_id, group_title, claimed_by, claimed_at FROM group_claims WHERE group_id = $1",
      [Number(key)],
    );
    const row = (rows as GroupClaimRow[])[0];
    return row ? rowToClaim(row) : undefined;
  }

  async write(key: string, value: GroupClaim): Promise<void> {
    // Upsert the parent `groups` row first so the FK from group_claims is
    // satisfied. ON CONFLICT keeps the existing title if we don't have a
    // new one (we don't want to blank a real title with NULL).
    await this.pool.query(
      `INSERT INTO groups (group_id, title, type)
       VALUES ($1, $2, 'group')
       ON CONFLICT (group_id) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, groups.title)`,
      [value.group_id, value.group_title ?? null],
    );
    await this.pool.query(
      `INSERT INTO group_claims (group_id, claimed_by, claimed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (group_id) DO NOTHING`,
      [value.group_id, value.claimed_by, value.claimed_at],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query("DELETE FROM group_claims WHERE group_id = $1", [Number(key)]);
  }

  async has(key: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM group_claims WHERE group_id = $1 LIMIT 1",
      [Number(key)],
    );
    return (rows as unknown[]).length > 0;
  }

  readAllKeys(): AsyncIterableIterator<string> {
    return (async function* (this: PostgresGroupAdapter) {
      const { rows } = await this.pool.query("SELECT group_id FROM group_claims");
      for (const r of rows as Array<{ group_id: string | number }>) {
        yield String(r.group_id);
      }
    }).call(this);
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

/**
 * createGroupStore — build the right GroupStore for the current environment.
 * Pick order (first non-null wins): PostgreSQL → Redis → in-memory.
 * Mirrors createAgentStore().
 */
export function createGroupStore(
  env: { DATABASE_URL?: string; REDIS_URL?: string } = process.env,
  db: PgPool | null = null,
): GroupStore {
  if (env.DATABASE_URL && db) return new GroupStore(new PostgresGroupAdapter(db));
  if (env.REDIS_URL) {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    const client: RedisLike = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    return new GroupStore(new RedisSessionStorage<GroupClaim>(client, "group:"));
  }
  return new GroupStore(new MemorySessionStorage<GroupClaim>());
}
