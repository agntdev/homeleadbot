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
  /** E1T3: group_id the agent is currently renaming (next text message
   *  is treated as the new title). Cleared once the rename completes. */
  renaming_group_id?: number;
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
 * The My groups menu button is special: tapping it should OPEN the /groups
 * management list (not just a one-line toast). The callback handler in
 * buildBot() routes `menu:groups` to renderGroupsList() and answers the
 * callback with a short "Loading..." toast so the spinner stops while the
 * list is being fetched.
 */
const GROUPS_MENU_DATA = `${MENU_PREFIX}groups`;

/** Commands the bot currently recognises (T03, E1T3). Kept in sync with
 *  `bot.command` registrations below so the unknown-command middleware
 *  doesn't shadow them. */
const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "help",
  "groups",
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

/** Callback prefix for the /groups management buttons (E1T3).
 *  `groups:detach:<id>` — detaches the claim; `groups:rename:<id>` —
 *  prompts the agent to send the new title as their next message. */
const GROUPS_PREFIX = "groups:";
const GROUPS_DETACH = "detach:";
const GROUPS_RENAME = "rename:";

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
 * renderGroupsList — shared renderer for the /groups command and the
 * main-menu My groups button (E1T3). Reads the agent's claimed groups and
 * emits a message with one inline-keyboard row per group: [Rename] [Detach].
 * The empty state (no claimed groups) gets a friendly nudge pointing at
 * the E1T2 claim flow. Pulled out of buildBotWithStores so the test
 * harness can exercise it without spinning a Bot instance.
 */
export async function renderGroupsList(
  ctx: BotContext<Session>,
  agentStore: AgentStore,
  groupStore: GroupStore,
): Promise<void> {
  const agentId = ctx.from?.id;
  if (agentId === undefined) {
    await ctx.reply("Could not identify you — try /groups from a Telegram account.");
    return;
  }
  // Touch the agent store so the agent is at least registered before we
  // list their groups. Cheap: get() is a single read; if it fails we still
  // proceed (the storage may have been wiped, but listing should still
  // work).
  await agentStore.get(agentId);
  const groups = await groupStore.listByAgent(agentId);
  if (groups.length === 0) {
    await ctx.reply(
      "You haven't claimed any groups yet. Add the bot to a Telegram group and an admin can tap “Claim this group” to start receiving lead notifications.",
    );
    return;
  }
  const rows = groups.map((g) => [
    { text: "✏️ Rename", callback_data: `${GROUPS_PREFIX}${GROUPS_RENAME}${g.group_id}` },
    { text: "🗑 Detach", callback_data: `${GROUPS_PREFIX}${GROUPS_DETACH}${g.group_id}` },
  ]);
  const header =
    `Your claimed groups (${groups.length}):\n` +
    groups.map((g, i) => `${i + 1}. ${g.group_title ?? `Group ${g.group_id}`} (id \`${g.group_id}\`)`).join("\n") +
    `\n\nTap Rename to set a new name (send the new title as your next message), or Detach to stop receiving leads for that group.`;
  await ctx.reply(header, { reply_markup: { inline_keyboard: rows } });
}

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

  // /groups — E1T3 management command. Renders the agent's claimed groups
  // with per-group Detach / Rename buttons. Empty state ("no groups yet")
  // gets a friendly nudge pointing at the claim flow (E1T2).
  bot.command("groups", async (ctx: BotContext<Session>) => {
    await renderGroupsList(ctx, agentStore, groupStore);
  });

  // /bang — debug hook: intentionally throws so operators (and the test
  // harness) can verify the error boundary is alive. The boundary's graceful
  // reply is the contract — without /bang, a real bug would also be caught
  // by the boundary but with no way to confirm in a live deployment.
  bot.command("bang", async () => {
    throw new Error("intentional /bang error (used to verify the error boundary)");
  });

  // Unknown-command fallback (T03) + rename-text pickup (E1T3). Order
  // matters: a non-command text message first checks for a pending rename
  // (session.renaming_group_id set by the groups:rename callback); if no
  // rename is pending we fall through to the normal handler chain. For
  // messages that DO start with "/", we route known vs unknown commands
  // the same way T03 does.
  bot.on("message", async (ctx: BotContext<Session>, next) => {
    const msg = ctx.message;
    if (!msg || !msg.text) return next();

    // E1T3: rename pickup. Only consume the message if it's a plain text
    // reply (not a /command) and the session has a pending rename.
    if (
      ctx.session.renaming_group_id !== undefined &&
      !msg.text.startsWith("/")
    ) {
      const groupId = ctx.session.renaming_group_id;
      ctx.session.renaming_group_id = undefined;
      const newTitle = msg.text.trim();
      if (newTitle.length === 0) {
        await ctx.reply("Empty title — rename cancelled.");
        return;
      }
      const updated = await groupStore.updateTitle(groupId, newTitle);
      if (updated) {
        await ctx.reply(`Renamed to “${newTitle}”.`);
      } else {
        await ctx.reply("That group is no longer claimed — nothing to rename.");
      }
      return;
    }

    if (!msg.text.startsWith("/")) return next();
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

    if (data === GROUPS_MENU_DATA) {
      // Open the /groups management list inline (E1T3). Spinner stops
      // first so the user sees immediate feedback, then the list arrives
      // as a fresh message in the same chat.
      await ctx.answerCallbackQuery({ text: "Loading your groups..." });
      await renderGroupsList(ctx, agentStore, groupStore);
      return;
    }

    if (data.startsWith(GROUPS_PREFIX)) {
      // /groups management actions: detach or rename a claimed group.
      if (data.startsWith(GROUPS_DETACH, GROUPS_PREFIX.length)) {
        const groupIdStr = data.slice(GROUPS_PREFIX.length + GROUPS_DETACH.length);
        const groupId = Number.parseInt(groupIdStr, 10);
        if (!Number.isFinite(groupId)) {
          await ctx.answerCallbackQuery({ text: "Malformed detach request." });
          return;
        }
        const removed = await groupStore.detach(groupId);
        if (removed) {
          await ctx.answerCallbackQuery({ text: "Group detached." });
          try {
            await ctx.editMessageText("This group is no longer claimed. Lead notifications will stop.");
          } catch { /* message may be uneditable; the toast is enough */ }
        } else {
          await ctx.answerCallbackQuery({ text: "This group is no longer claimed." });
        }
        return;
      }
      if (data.startsWith(GROUPS_RENAME, GROUPS_PREFIX.length)) {
        const groupIdStr = data.slice(GROUPS_PREFIX.length + GROUPS_RENAME.length);
        const groupId = Number.parseInt(groupIdStr, 10);
        if (!Number.isFinite(groupId) || !ctx.from) {
          await ctx.answerCallbackQuery({ text: "Malformed rename request." });
          return;
        }
        // Stash the pending rename in the session. The next non-command
        // text message from this user is treated as the new title.
        ctx.session.renaming_group_id = groupId;
        await ctx.answerCallbackQuery({ text: "Send the new name as your next message." });
        await ctx.reply(`Sure — send me the new name for this group as your next message. (Title will be applied on the next text you send.)`);
        return;
      }
    }

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
  //
  // Before sending the prompt we register the group's title with the
  // store (E1T3) so the claim callback can attach a real title to the
  // new claim. The button's callback_data only carries the group_id
  // (Telegram caps callback_data at 64 bytes, which isn't enough for a
  // real title), so the store is the only place to stash it.
  bot.on("my_chat_member", async (ctx: BotContext<Session>) => {
    const mcm = ctx.myChatMember;
    if (!mcm) return;
    const chat = mcm.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") return;
    if (!BOT_IN_CHAT_STATUSES.has(mcm.new_chat_member.status)) return;
    if (await groupStore.has(chat.id)) return; // already claimed — stay quiet.
    await groupStore.registerGroup({ id: chat.id, type: chat.type, ...(chat.title ? { title: chat.title } : {}) });
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
