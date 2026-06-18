import { createRequire } from "node:module";
import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import {
  RedisSessionStorage,
  type RedisLike,
} from "../toolkit/session/redis.js";
import type { PgPool } from "./db.js";

/**
 * Durable agent record (E1T1, E5T1). One per Telegram user who has run
 * /start. Keyed by Telegram user ID; lives in PostgreSQL (when DATABASE_URL
 * is set), Redis (when REDIS_URL is set, legacy), or in-memory (test /
 * dev). Source of truth for "this user is a registered HomeLeadBot agent"
 * — lead-notification routing (E4) reads from this store to find the
 * claiming agent for a Telegram user.
 */
export interface AgentRecord {
  /** Telegram user ID — unique, immutable. The Redis key / Postgres PK. */
  telegram_id: number;
  /** Best display name we have for the user. Falls back to "user<id>". */
  display_name: string;
  /** Telegram @username, if the user has one set. Optional. */
  username?: string;
  /** ISO 8601 timestamp of the first /start. Never overwritten on re-/start. */
  registered_at: string;
  /** ISO 8601 timestamp of the most recent /start. */
  updated_at: string;
}

/** Minimal Telegram User shape we read from ctx.from. Avoids pulling in
 *  grammY's full User type in the storage layer. */
export interface TelegramUserRef {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * AgentStore — durable key-value store keyed by Telegram user ID. The class
 * is backend-agnostic: the storage adapter is injected, so the same class
 * fronts the PostgreSQL, Redis, and in-memory implementations. The factory
 * `createAgentStore()` picks the backend.
 */
export class AgentStore {
  constructor(private readonly storage: StorageAdapter<AgentRecord>) {}

  /** Read a single agent by Telegram user ID. Returns undefined if not registered. */
  async get(telegramId: number): Promise<AgentRecord | undefined> {
    return this.storage.read(String(telegramId));
  }

  /** Check whether a Telegram user is already registered. */
  async has(telegramId: number): Promise<boolean> {
    const v = await this.storage.read(String(telegramId));
    return v !== undefined;
  }

  /**
   * Register (or update) an agent from a Telegram User object. Idempotent:
   * a re-registration refreshes display_name / username / updated_at but
   * preserves the original registered_at. Returns the persisted record
   * plus a flag indicating whether this was a new registration.
   */
  async registerFromTelegramUser(
    user: TelegramUserRef,
  ): Promise<{ record: AgentRecord; isNew: boolean }> {
    const existing = await this.get(user.id);
    const now = new Date().toISOString();
    const display_name = composeDisplayName(user);
    const record: AgentRecord = {
      telegram_id: user.id,
      display_name,
      ...(user.username ? { username: user.username } : {}),
      registered_at: existing?.registered_at ?? now,
      updated_at: now,
    };
    await this.storage.write(String(record.telegram_id), record);
    return { record, isNew: !existing };
  }
}

/** Compose the best display name from a Telegram User's name parts. */
function composeDisplayName(user: TelegramUserRef): string {
  const parts = [user.first_name, user.last_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  if (parts.length > 0) return parts.join(" ");
  if (user.username) return `@${user.username}`;
  return `user${user.id}`;
}

/**
 * PostgresAgentAdapter — grammY StorageAdapter backed by the `agents` table.
 * Implements the read / write / delete / has / readAllKeys surface. Key is
 * the string form of the Telegram user ID; the column `telegram_id` is
 * BIGINT. Timestamps are stored as ISO 8601 strings (TEXT) so the schema
 * is easy to inspect without a timezone dance.
 */
class PostgresAgentAdapter implements StorageAdapter<AgentRecord> {
  constructor(private readonly pool: PgPool) {}

  async read(key: string): Promise<AgentRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT telegram_id, display_name, username, registered_at, updated_at FROM agents WHERE telegram_id = $1",
      [Number(key)],
    );
    const row = (rows as AgentRow[])[0];
    return row ? rowToRecord(row) : undefined;
  }

  async write(key: string, value: AgentRecord): Promise<void> {
    // ON CONFLICT updates the mutable fields and bumps updated_at, but
    // preserves the original registered_at (we pass COALESCE so a re-insert
    // can't accidentally reset it).
    await this.pool.query(
      `INSERT INTO agents (telegram_id, display_name, username, registered_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (telegram_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         username     = EXCLUDED.username,
         updated_at   = EXCLUDED.updated_at`,
      [
        Number(key),
        value.display_name,
        value.username ?? null,
        value.registered_at,
        value.updated_at,
      ],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query("DELETE FROM agents WHERE telegram_id = $1", [Number(key)]);
  }

  async has(key: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM agents WHERE telegram_id = $1 LIMIT 1",
      [Number(key)],
    );
    return (rows as unknown[]).length > 0;
  }

  readAllKeys(): AsyncIterableIterator<string> {
    return (async function* (this: PostgresAgentAdapter) {
      const { rows } = await this.pool.query(
        "SELECT telegram_id FROM agents",
      );
      for (const r of rows as Array<{ telegram_id: string | number }>) {
        yield String(r.telegram_id);
      }
    }).call(this);
  }
}

interface AgentRow {
  telegram_id: string | number;
  display_name: string;
  username: string | null;
  registered_at: string;
  updated_at: string;
}

function rowToRecord(row: AgentRow): AgentRecord {
  return {
    telegram_id: Number(row.telegram_id),
    display_name: row.display_name,
    ...(row.username ? { username: row.username } : {}),
    registered_at: row.registered_at,
    updated_at: row.updated_at,
  };
}

/**
 * createAgentStore — build the right AgentStore for the current environment.
 * Pick order (first non-null wins): PostgreSQL → Redis → in-memory.
 * PostgreSQL takes precedence so production deployments get durable,
 * relational storage; Redis is the legacy path; in-memory is the test
 * harness.
 */
export function createAgentStore(
  env: { DATABASE_URL?: string; REDIS_URL?: string } = process.env,
  db: PgPool | null = null,
): AgentStore {
  if (env.DATABASE_URL && db) return new AgentStore(new PostgresAgentAdapter(db));
  if (env.REDIS_URL) {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    const client: RedisLike = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    return new AgentStore(new RedisSessionStorage<AgentRecord>(client, "agent:"));
  }
  return new AgentStore(new MemorySessionStorage<AgentRecord>());
}
