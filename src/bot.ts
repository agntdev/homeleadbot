import { createBot, type BotContext } from "./toolkit/index.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
}

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Project-specific entry behavior for HomeLeadBot (T01). T02 will replace
  // this with a full main menu (inline keyboard routing to top-level features).
  bot.command("start", async (ctx: BotContext<Session>) => {
    const name = ctx.from?.first_name ?? "there";
    await ctx.reply(
      `Welcome to HomeLeadBot, ${name}! 🏠\n\n` +
        `I help real estate agents post listings, capture buyer leads, and ` +
        `deliver hot-lead notifications. Send /help any time to see what I can do.`,
    );
  });

  return bot;
}
