import {
  createBot,
  type BotContext,
  inlineButton,
  inlineKeyboard,
} from "./toolkit/index.js";
import { createAgentStore, type AgentStore } from "./storage/agents.js";
import { createGroupStore, type GroupStore } from "./storage/groups.js";
import { createDb, type PgPool } from "./storage/db.js";
import { runMigration } from "./storage/migrate.js";

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

/** Telegram chat-member statuses that mean "the bot is in the chat". E1T2
 *  only prompts for a group claim on transitions INTO one of these. */
const BOT_IN_CHAT_STATUSES: ReadonlySet<string> = new Set([
  "member",
  "administrator",
  "creator",
]);

/** Callback prefix for the inline "Claim this group" button (E1T2). */
const CLAIM_GROUP_PREFIX = "claim_group:";

/** Text shown in the group chat when the bot is added, prompting an admin
 *  to claim it for lead notifications. */
const CLAIM_PROMPT_TEXT =
  "Hi! I'm HomeLeadBot 🏠 — I help real estate agents post listings, " +
  "capture buyer leads, and deliver hot-lead notifications.\n\n" +
  "An admin can claim this group to start receiving leads posted via " +
  "the 'I'm interested' button on listings.";

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
 *
 * Sync on purpose: the test harness's runner calls makeBot() synchronously
 * (see src/toolkit/harness/run-specs.ts), so the bot must be buildable without
 * any async setup. Schema migration and DB connection are the caller's
 * responsibility — see `runMigrationsAndBuildBot()` for the production
 * startup wrapper, and `index.ts` for the wiring.
 */
export function buildBot(
  token: string,
  opts: { db?: PgPool | null } = {},
) {
  const db = opts.db ?? null;
  return buildBotWithStores(
    token,
    createAgentStore(process.env, db),
    createGroupStore(process.env, db),
  );
}

/**
 * runMigrationsAndBuildBot — production startup wrapper: opens the
 * PostgreSQL pool (if DATABASE_URL is set), runs the idempotent schema
 * migration, then builds the bot. Throws on migration failure so the
 * platform's restart policy can recycle the process. Without DATABASE_URL
 * the build proceeds with Redis (REDIS_URL) or in-memory storage.
 */
export async function runMigrationsAndBuildBot(token: string) {
  const db = createDb();
  if (db) {
    await runMigration(db);
  }
  return buildBot(token, { db });
}

/**
 * buildBotWithStores — same as buildBot, but takes explicit stores. Used by
 * the test harness (and any future integration tests) to inject deterministic
 * storage. Production code goes through runMigrationsAndBuildBot() which
 * calls the create* factories and reads DATABASE_URL / REDIS_URL.
 */
export function buildBotWithStores(
  token: string,
  agentStore: AgentStore,
  groupStore: GroupStore,
) {
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

  // Main-menu + group-claim router. Each menu button gets an honest
  // acknowledgement now (the spinner stops) and a one-line note about the
  // feature in flight. Future tasks will replace the per-route handler
  // with the real flow.
  //
  // The `claim_group:<group_id>` callback (E1T2) is handled here too:
  // whoever taps the button first records the claim (subsequent taps are
  // no-ops with an "already claimed" toast), and the prompt message is
  // edited in place to a "group is now claimed" byline.
  bot.on("callback_query:data", async (ctx: BotContext<Session>) => {
    const cq = ctx.callbackQuery;
    if (!cq) return; // not a callback_query update — nothing to route.
    const data = cq.data;
    if (!data) return; // callback query without data — nothing we can route.

    if (data.startsWith(CLAIM_GROUP_PREFIX)) {
      const claimedBy = ctx.from?.id;
      if (claimedBy === undefined) {
        await ctx.answerCallbackQuery({ text: "Could not identify you — try again from a Telegram account." });
        return;
      }
      // Resolve the group from the button's callback data. If the data is
      // malformed (no group_id), treat it as a no-op and answer the query.
      const groupIdStr = data.slice(CLAIM_GROUP_PREFIX.length);
      const groupId = Number.parseInt(groupIdStr, 10);
      if (!Number.isFinite(groupId)) {
        await ctx.answerCallbackQuery({ text: "Malformed claim request." });
        return;
      }
      const { claim, isNew } = await groupStore.claim(
        { id: groupId, type: "group" },
        claimedBy,
      );
      if (isNew) {
        // Answer the callback FIRST so the spinner stops immediately, then
        // update the message text. (Answering later risks a stuck spinner
        // if the edit throws.)
        await ctx.answerCallbackQuery({ text: "Group claimed!" });
        try {
          await ctx.editMessageText("This group is now claimed. Lead notifications will route to the claiming agent.");
        } catch {
          // The message may already be deleted or uneditable (e.g. the bot
          // was kicked). The callback is already answered, so the user sees
          // their toast; no further action needed.
        }
      } else {
        const existingBy = claim.claimed_by === claimedBy
          ? "You already claimed this group."
          : "This group is already claimed by another agent.";
        await ctx.answerCallbackQuery({ text: existingBy });
      }
      return;
    }

    const route = MAIN_MENU_BUTTONS.find((b) => b.data === data);
    if (!route) return; // not for us — let other handlers / the unknown-command fallback deal with it.
    await ctx.answerCallbackQuery({ text: route.note });
  });

  // Group-addition prompt (E1T2). Telegram sends a `my_chat_member` update
  // when the bot's status in a chat changes. We only act on transitions INTO
  // an in-chat status (member/administrator/creator) in a group or
  // supergroup, AND only when the group hasn't already been claimed —
  // re-prompting on every status change would be noise.
  bot.on("my_chat_member", async (ctx: BotContext<Session>) => {
    const mcm = ctx.myChatMember;
    if (!mcm) return;
    const chat = mcm.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!BOT_IN_CHAT_STATUSES.has(mcm.new_chat_member.status)) return;
    if (await groupStore.has(chat.id)) return; // already claimed — stay quiet.
    await ctx.api.sendMessage(chat.id, CLAIM_PROMPT_TEXT, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Claim this group", callback_data: `${CLAIM_GROUP_PREFIX}${chat.id}` },
        ]],
      },
    });
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
