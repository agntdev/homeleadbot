import {
  createBot,
  type BotContext,
  inlineButton,
  inlineKeyboard,
} from "./toolkit/index.js";
import { createAgentStore, type AgentStore } from "./storage/agents.js";

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

/** Commands the bot currently recognises (T03). Kept in sync with `bot.command`
 *  registrations below so the unknown-command middleware doesn't shadow them. */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "help",
  "bang",
]);

/** Render the help text (T03). Kept as a pure function so the tests can assert
 *  against it without spinning a real bot. */
export function helpText(): string {
  return [
    "Here's what I can do:",
    "",
    "/start — Show the main menu",
    "/help  — Show this help message",
    "",
    "Or tap a button on the main menu to get started.",
  ].join("\n");
}

/** Friendly reply for an unknown /command (T03). */
function unknownCommandReply(cmd: string): string {
  return `Hmm, /${cmd} isn't a command I know. Try /help to see what I can do.`;
}

/** Graceful error reply when a handler throws (T03). The user sees this
 *  instead of the bot silently dying on a network blip or bad input. */
const ERROR_BOUNDARY_REPLY =
  "Sorry, something went wrong on my side. Please try again in a moment.";

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const agentStore = createAgentStore();
  return buildBotWithStore(token, agentStore);
}

/**
 * buildBotWithStore — same as buildBot, but takes an explicit AgentStore.
 * Used by the test harness (and any future integration tests) to inject a
 * deterministic store. Production code goes through buildBot() which calls
 * createAgentStore() and reads REDIS_URL.
 */
export function buildBotWithStore(token: string, agentStore: AgentStore) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Global error boundary (T03). Installed FIRST via bot.use so it wraps every
  // subsequent middleware (session, command handlers, callback router, etc.)
  // — when anything downstream throws, this catches it and sends a graceful
  // user-facing reply. The test harness reaches this through `handleUpdate`
  // (the polling-layer `bot.catch` is only invoked by long polling), so this
  // is the boundary the dialog tests actually exercise.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("[agntdev-bot] unhandled error:", err);
      try {
        await ctx.reply(ERROR_BOUNDARY_REPLY);
      } catch (replyErr) {
        // The boundary must NEVER throw — a secondary failure here would mask
        // the original error and risk crashing the polling loop.
        console.error("[agntdev-bot] failed to send error reply:", replyErr);
      }
      // Swallow — the error is gracefully handled. (If we rethrew, the
      // polling-layer `bot.catch` would also fire and double-log.)
    }
  });

  // /start — HomeLeadBot welcome + the bot's main menu (T02). E1T1 layers
  // the agent-registration side effect on top: every /start upserts an
  // AgentRecord (Telegram ID + display name + username + timestamps) in the
  // durable AgentStore, and the welcome copy adapts to whether the agent
  // is brand-new or returning.
  bot.command("start", async (ctx: BotContext<Session>) => {
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

    let greeting: string;
    if (ctx.from) {
      const { record, isNew } = await agentStore.registerFromTelegramUser(ctx.from);
      greeting = isNew
        ? `Welcome to HomeLeadBot, ${record.display_name}! 🏠\n\n` +
          `You're registered as an agent. I help you post listings, capture ` +
          `buyer leads, and deliver hot-lead notifications. Pick an option ` +
          `below to get started.`
        : `Welcome back, ${record.display_name}! 🏠\n\n` +
          `I help you post listings, capture buyer leads, and deliver ` +
          `hot-lead notifications. Pick an option below to get started.`;
    } else {
      // No `from` (e.g. a channel post the bot received anonymously). Still
      // show the menu so the dialog test has something to assert — but skip
      // the registration (we don't have a Telegram ID to store).
      greeting =
        `Welcome to HomeLeadBot! 🏠\n\n` +
        `I help real estate agents post listings, capture buyer leads, and ` +
        `deliver hot-lead notifications. Pick an option below to get started.`;
    }

    await ctx.reply(greeting, { reply_markup: keyboard });
  });

  // /help — list the bot's commands (T03).
  bot.command("help", async (ctx: BotContext<Session>) => {
    await ctx.reply(helpText());
  });

  // /bang — debug hook: intentionally throws so operators (and the test
  // harness) can verify the error boundary is alive. The boundary's graceful
  // reply is the contract — without /bang, a real bug would also be caught
  // by the boundary but with no way to confirm in a live deployment.
  bot.command("bang", async () => {
    throw new Error("intentional /bang error (used to verify the error boundary)");
  });

  // Unknown-command fallback (T03). Intercepts every inbound message BEFORE
  // the command router: if the message starts with a /command that isn't in
  // KNOWN_COMMANDS, reply with a friendly nudge and stop the chain so the
  // command router never sees it. Passes through to next() otherwise, so
  // known commands (and non-command text) reach their normal handlers.
  bot.on("message", async (ctx: BotContext<Session>, next) => {
    const msg = ctx.message;
    if (!msg || !msg.text || !msg.text.startsWith("/")) return next();
    const entity = msg.entities?.find((e) => e.type === "bot_command");
    if (!entity) return next();
    const raw = msg.text.substring(entity.offset + 1, entity.offset + entity.length);
    const cmd = raw.split("@")[0]!.toLowerCase();
    if (KNOWN_COMMANDS.has(cmd)) return next();
    await ctx.reply(unknownCommandReply(cmd));
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

  // Polling-layer error boundary (T03). Catches anything that escapes the
  // middleware stack (e.g. errors thrown by the transformer chain or by
  // long-polling internals). The middleware-level boundary above handles
  // handler errors; this is the second line of defence.
  bot.catch((err) => {
    console.error("[agntdev-bot] polling-layer error:", err);
  });

  return bot;
}
