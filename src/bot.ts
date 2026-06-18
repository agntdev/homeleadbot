import {
  createBot,
  type BotContext,
  inlineButton,
  inlineKeyboard,
} from "./toolkit/index.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
}

/** Callback prefix for main-menu buttons. Routed in the callback handler below. */
const MENU_PREFIX = "menu:";

const MAIN_MENU_BUTTONS: ReadonlyArray<{ text: string; data: string; note: string }> = [
  { text: "📝 Create listing", data: `${MENU_PREFIX}create_listing`, note: "Create a new listing (E2T1)." },
  { text: "🏠 Find a home",   data: `${MENU_PREFIX}find_home`,      note: "Start the buyer intake (E3T1)." },
  { text: "👥 My groups",     data: `${MENU_PREFIX}groups`,         note: "Manage claimed groups (E1T3)." },
  { text: "❓ Help",          data: `${MENU_PREFIX}help`,           note: "List the bot's commands (T03)." },
];

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

  // /start — HomeLeadBot welcome + the bot's main menu (T02). T02 owns the
  // menu structure; later feature tasks (E1T1, E2T1, E3T1, etc.) deepen the
  // individual menu routes with real flows. (T01 shipped a simpler HomeLeadBot
  // welcome — T02 supersedes it by adding the inline-keyboard menu.)
  bot.command("start", async (ctx: BotContext<Session>) => {
    const name = ctx.from?.first_name ?? "there";
    const keyboard = inlineKeyboard([
      [
        inlineButton(MAIN_MENU_BUTTONS[0].text, MAIN_MENU_BUTTONS[0].data),
        inlineButton(MAIN_MENU_BUTTONS[1].text, MAIN_MENU_BUTTONS[1].data),
      ],
      [
        inlineButton(MAIN_MENU_BUTTONS[2].text, MAIN_MENU_BUTTONS[2].data),
        inlineButton(MAIN_MENU_BUTTONS[3].text, MAIN_MENU_BUTTONS[3].data),
      ],
    ]);
    await ctx.reply(
      `Welcome to HomeLeadBot, ${name}! 🏠\n\n` +
        `I help real estate agents post listings, capture buyer leads, and ` +
        `deliver hot-lead notifications. Pick an option below to get started.`,
      { reply_markup: keyboard },
    );
  });

  // Main-menu router. Each button gets an honest acknowledgement now (the
  // spinner stops) and a one-line note about the feature in flight. Future
  // tasks will replace the per-route handler with the real flow.
  bot.on("callback_query:data", async (ctx: BotContext<Session>) => {
    const cq = ctx.callbackQuery;
    if (!cq) return; // not a callback_query update — nothing to route.
    const route = MAIN_MENU_BUTTONS.find((b) => b.data === cq.data);
    if (!route) return; // not for us — let other handlers / the unknown-command fallback deal with it.
    await ctx.answerCallbackQuery({ text: route.note });
  });

  return bot;
}
