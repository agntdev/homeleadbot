import {
  Bot,
  session,
  type Context,
  type SessionFlavor,
  type StorageAdapter,
} from "grammy";
import { resolveSessionStorage } from "./session/redis.js";

/** Context for a toolkit bot carrying a typed session `S`. */
export type BotContext<S extends object = Record<string, unknown>> = Context & SessionFlavor<S>;

export interface CreateBotOptions<S extends object> {
  /** Initial session value for a new chat. */
  initial: () => S;
  /**
   * Session storage. When omitted, the toolkit auto-selects: Redis if
   * REDIS_URL is set in the environment (production), else in-memory
   * (development / no Redis). Pass an explicit adapter to override.
   */
  storage?: StorageAdapter<S>;
  /** Called on any unhandled handler error; defaults to console.error. */
  onError?: (err: unknown) => void;
}

/**
 * createBot — the toolkit's curated entry point. Wraps grammY's Bot with the
 * default session middleware and an error boundary, so every generated bot
 * shares one opinionated structure: the Dev-stage codegen targets this API, and
 * the test harness (M0-10) replays Updates against bots built here.
 *
 * The BotFather token is injected at runtime (never baked); polling vs webhook
 * is chosen at deploy time (docs/pivot M1-7).
 */
export function createBot<S extends object>(
  token: string,
  opts: CreateBotOptions<S>,
): Bot<BotContext<S>> {
  const bot = new Bot<BotContext<S>>(token);
  bot.use(
    session<S, BotContext<S>>({
      initial: opts.initial,
      // Auto-select: explicit adapter → Redis (REDIS_URL) → in-memory.
      storage: resolveSessionStorage<S>(opts.storage),
    }),
  );
  bot.catch((err) => {
    if (opts.onError) opts.onError(err);
    else console.error("[agntdev-bot] unhandled error:", err);
  });
  return bot;
}
