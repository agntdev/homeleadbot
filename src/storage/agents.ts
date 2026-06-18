import { createRequire } from "node:module";
import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import {
  RedisSessionStorage,
  type RedisLike,
} from "../toolkit/session/redis.js";

/**
 * Durable agent record (E1T1). One per Telegram user who has run /start. The
 * record is keyed by Telegram user ID, lives in Redis (when REDIS_URL is set)
 * or in-memory (dev / test harness), and is the source of truth for "this user
 * is a registered HomeLeadBot agent". Lead-notification routing (E4) reads
 * from this store to find the claiming agent for a Telegram user.
 *
 * NOTE: this is intentionally a flat record. Group claims, listings, and leads
 * land in their own stores (E1T2, E2T1, E3T1, E5). Don't grow this struct —
 * add a new store + a foreign-key reference instead.
 */
export interface AgentRecord {
  /** Telegram user ID — unique, immutable. The Redis key. */
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
 * AgentStore — durable key-value store keyed by Telegram user ID. Backed by
 * the toolkit's RedisSessionStorage (prefix `agent:`) when REDIS_URL is set,
 * and by MemorySessionStorage otherwise. The two share a grammY
 * StorageAdapter interface, so swapping the backend is a one-line factory
 * change.
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
 * createAgentStore — build the right AgentStore for the current environment.
 * Mirrors the toolkit's session-storage auto-select: Redis if REDIS_URL is
 * set, else in-memory. Always returns a concrete store — there is no "no
 * storage" code path (E1T1's contract is that /start ALWAYS registers).
 */
export function createAgentStore(env: { REDIS_URL?: string } = process.env): AgentStore {
  if (env.REDIS_URL) {
    const require = createRequire(import.meta.url);
    // ioredis is loaded lazily (via createRequire) so a bot that never sets
    // REDIS_URL doesn't pull it in.
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
