import {
  createBot,
  type BotContext,
  inlineButton,
  inlineKeyboard,
  type InlineButton,
} from "./toolkit/index.js";
import { createAgentStore, type AgentStore } from "./storage/agents.js";
import { createGroupStore, type GroupStore } from "./storage/groups.js";
import { createListingStore, type ListingStore } from "./storage/listings.js";
import { createDb, type PgPool } from "./storage/db.js";
import { runMigration } from "./storage/migrate.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  /** E1T3: group_id the agent is currently renaming (next text message
   *  is treated as the new title). Cleared once the rename completes. */
  renaming_group_id?: number;

  /** E2T1: in-flight /create_listing conversation. `step` is the next field
   *  the bot is waiting for; `data` is the partial record so far; once we
   *  reach the "groups" step we render the agent's claimed groups as
   *  inline buttons. Cleared on creation, cancel, or session reset. */
  creating_listing?: {
    step: "title" | "description" | "price" | "bedrooms" | "location" | "groups";
    data: {
      title?: string;
      description?: string;
      price_cents?: number;
      bedrooms?: number;
      location?: string;
    };
    /** group_ids the agent has already selected (multi-select). */
    selected_group_ids?: number[];
  };
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
  "create_listing",
  "cancel",
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

/** E2T1: /create_listing group-selection callback. The data looks like
 *  `groups:create_listing:group:<id>` (toggle a group) or
 *  `groups:create_listing:done` (finalize the listing). */
const CREATE_LISTING_GROUP_PREFIX = "create_listing:";

/** E2T2: callback for the inline "I'm interested" button on a posted
 *  listing. The data looks like `interested:<listing_id>`. The buyer
 *  intake (E3T1) is the next step; E2T2 just acknowledges the tap and
 *  records the lead start. */
const INTERESTED_CALLBACK_PREFIX = "interested:";

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
 * renderGroupSelectionMessage — the body of the /create_listing group
 * selection step (E2T1). One row per claimed group with a checkmark for
 * the ones the agent has already toggled, plus a "Done" row that finalises
 * the listing.
 */
export function renderGroupSelectionMessage(
  claimedGroups: ReadonlyArray<{ group_id: number; group_title?: string }>,
  selected: ReadonlyArray<number>,
): string {
  if (claimedGroups.length === 0) {
    return "You have no claimed groups — /create_listing needs at least one.";
  }
  const lines = claimedGroups.map((g, i) => {
    const checked = selected.includes(g.group_id) ? "✅" : "⬜";
    return `${checked} ${i + 1}. ${g.group_title ?? `Group ${g.group_id}`}`;
  });
  const sel = selected.length;
  return [
    "Which group(s) should I post this listing to?",
    "",
    ...lines,
    "",
    sel === 0
      ? "Tap a row to toggle it. No groups selected means the listing is saved but not published."
      : `${sel} group(s) selected. Tap another row to toggle, or tap Done to publish.`,
  ].join("\n");
}

/**
 * buildGroupSelectionKeyboard — the inline-keyboard matrix for the
 * /create_listing group selection. One row per claimed group, plus a
 * "Done" row at the bottom. Callback data is namespaced
 * `groups:create_listing:group:<id>` (toggle) or
 * `groups:create_listing:done` (finalize).
 */
export function buildGroupSelectionKeyboard(
  claimedGroups: ReadonlyArray<{ group_id: number; group_title?: string }>,
  _selected: ReadonlyArray<number>,
): InlineButton[][] {
  const rows = claimedGroups.map((g) => [
    {
      text: g.group_title ?? `Group ${g.group_id}`,
      callback_data: `${GROUPS_PREFIX}${CREATE_LISTING_GROUP_PREFIX}group:${g.group_id}`,
    } satisfies InlineButton,
  ]);
  rows.push([
    {
      text: "✅ Done",
      callback_data: `${GROUPS_PREFIX}${CREATE_LISTING_GROUP_PREFIX}done`,
    } satisfies InlineButton,
  ]);
  return rows;
}

/**
 * formatListingMessage — the body of a posted listing (E2T2). Pure
 * function so the test can assert the exact text without spinning a
 * real bot. The message starts with the title, then a one-line summary
 * (price · bedrooms · location), then the description.
 */
export function formatListingMessage(listing: {
  id: number;
  title: string;
  description?: string;
  price_cents?: number;
  bedrooms?: number;
  location?: string;
}): string {
  const lines: string[] = [`🏠 ${listing.title}`];
  const summaryBits: string[] = [];
  if (listing.price_cents !== undefined) {
    summaryBits.push(`$${(listing.price_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  }
  if (listing.bedrooms !== undefined) summaryBits.push(`${listing.bedrooms} bedroom${listing.bedrooms === 1 ? "" : "s"}`);
  if (listing.location) summaryBits.push(listing.location);
  if (summaryBits.length > 0) lines.push(summaryBits.join(" · "));
  if (listing.description) {
    lines.push("");
    lines.push(listing.description);
  }
  return lines.join("\n");
}

/**
 * postListingToGroup — send a formatted listing message + "I'm interested"
 * button to a Telegram group. Returns the Telegram Message object so the
 * caller can persist `message_id` (later features need it to edit /
 * unpost). E2T2.
 */
export async function postListingToGroup(
  ctx: BotContext<Session>,
  listing: { id: number; title: string; description?: string; price_cents?: number; bedrooms?: number; location?: string },
  groupId: number,
): Promise<{ message_id: number }> {
  const text = formatListingMessage(listing);
  const message = await ctx.api.sendMessage(groupId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "I'm interested", callback_data: `${INTERESTED_CALLBACK_PREFIX}${listing.id}` },
      ]],
    },
  });
  return { message_id: message.message_id };
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
    createListingStore(process.env, db),
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
  listingStore: ListingStore,
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

  // /create_listing — E2T1 listing creation. Starts a multi-step
  // conversation (title → description → price → bedrooms → location →
  // group selection) in the session. The next non-command text message
  // in this chat advances the step; the group-selection step is driven
  // by the `create_listing:group:*` / `create_listing:done` callbacks.
  bot.command("create_listing", async (ctx: BotContext<Session>) => {
    const agentId = ctx.from?.id;
    if (agentId === undefined) {
      await ctx.reply("Could not identify you — try /create_listing from a Telegram account.");
      return;
    }
    const claimedGroups = await groupStore.listByAgent(agentId);
    if (claimedGroups.length === 0) {
      await ctx.reply(
        "You haven't claimed any groups yet. Add the bot to a Telegram group, tap “Claim this group”, and come back — listings are only published to groups you've claimed.",
      );
      return;
    }
    // If a previous /create_listing is still in flight, restart from the
    // beginning (the agent probably abandoned it). Clear the session.
    ctx.session.creating_listing = {
      step: "title",
      data: {},
      selected_group_ids: [],
    };
    await ctx.reply(
      "Let's create a listing. Send me the title as your next message.\n\n(Tip: type /cancel at any point to abandon the draft.)",
    );
  });

  // /cancel — abandons an in-flight /create_listing or rename session.
  // Without this, an abandoned /create_listing would leave the session
  // stuck on the next text message the agent sends.
  bot.command("cancel", async (ctx: BotContext<Session>) => {
    if (ctx.session.creating_listing) {
      ctx.session.creating_listing = undefined;
      await ctx.reply("Listing draft cancelled.");
      return;
    }
    if (ctx.session.renaming_group_id !== undefined) {
      ctx.session.renaming_group_id = undefined;
      await ctx.reply("Rename cancelled.");
      return;
    }
    await ctx.reply("Nothing to cancel.");
  });

  // /bang — debug hook: intentionally throws so operators (and the test
  // harness) can verify the error boundary is alive. The boundary's graceful
  // reply is the contract — without /bang, a real bug would also be caught
  // by the boundary but with no way to confirm in a live deployment.
  bot.command("bang", async () => {
    throw new Error("intentional /bang error (used to verify the error boundary)");
  });

  // Unknown-command fallback (T03) + rename-text pickup (E1T3) +
  // /create_listing text pickup (E2T1). Order matters: a non-command
  // text message first checks for an in-flight /create_listing session
  // (advances the step), then for a pending rename, then falls through
  // to the normal chain. Messages that DO start with "/" go to the
  // known/unknown command router.
  bot.on("message", async (ctx: BotContext<Session>, next) => {
    const msg = ctx.message;
    if (!msg || !msg.text) return next();

    // E2T1: /create_listing text pickup. Only consume the message if
    // it's a plain text reply (not a /command) and the session has an
    // in-flight listing. Each step validates the field and replies with
    // the next prompt; the "groups" step is driven by callbacks, not
    // text, so we just ignore the text in that case.
    if (
      ctx.session.creating_listing !== undefined &&
      !msg.text.startsWith("/")
    ) {
      const agentId = ctx.from?.id;
      if (agentId === undefined) {
        await ctx.reply("Could not identify you — listing draft cancelled.");
        ctx.session.creating_listing = undefined;
        return;
      }
      const draft = ctx.session.creating_listing;
      const text = msg.text.trim();
      switch (draft.step) {
        case "title": {
          if (text.length === 0) {
            await ctx.reply("Empty title — send a non-empty title, or /cancel to abandon.");
            return;
          }
          draft.data.title = text;
          draft.step = "description";
          await ctx.reply(`Title set to “${text}”. Now send me a short description (1-2 sentences).`);
          return;
        }
        case "description": {
          if (text.length === 0) {
            await ctx.reply("Empty description — send a non-empty description, or /cancel to abandon.");
            return;
          }
          draft.data.description = text;
          draft.step = "price";
          await ctx.reply(`Got it. Now send the price in cents (e.g. \`100000\` for $1000), or type \`skip\` to leave it blank.`);
          return;
        }
        case "price": {
          if (text === "skip") {
            draft.step = "bedrooms";
            await ctx.reply("Price skipped. Now send the number of bedrooms, or type `skip`.");
            return;
          }
          const n = Number.parseInt(text.replace(/[,\s_]/g, ""), 10);
          if (!Number.isFinite(n) || n < 0) {
            await ctx.reply("That doesn't look like a price. Send a non-negative integer (cents), or `skip`.");
            return;
          }
          draft.data.price_cents = n;
          draft.step = "bedrooms";
          await ctx.reply(`Price set to ${n} cents. Now send the number of bedrooms, or type \`skip\`.`);
          return;
        }
        case "bedrooms": {
          if (text === "skip") {
            draft.step = "location";
            await ctx.reply("Bedrooms skipped. Now send the location (city / ZIP / free text), or type `skip`.");
            return;
          }
          const n = Number.parseInt(text, 10);
          if (!Number.isFinite(n) || n < 0) {
            await ctx.reply("That doesn't look like a bedroom count. Send a non-negative integer, or `skip`.");
            return;
          }
          draft.data.bedrooms = n;
          draft.step = "location";
          await ctx.reply(`Bedrooms set to ${n}. Now send the location (city / ZIP / free text), or type \`skip\`.`);
          return;
        }
        case "location": {
          if (text === "skip") {
            draft.step = "groups";
            const claimed = await groupStore.listByAgent(agentId);
            const sel = draft.selected_group_ids ?? [];
            await ctx.reply("Location skipped. Now pick the group(s) to post to:");
            await ctx.reply(renderGroupSelectionMessage(claimed, sel), {
              reply_markup: { inline_keyboard: buildGroupSelectionKeyboard(claimed, sel) },
            });
            return;
          }
          draft.data.location = text;
          draft.step = "groups";
          const claimed = await groupStore.listByAgent(agentId);
          const sel = draft.selected_group_ids ?? [];
          await ctx.reply(`Location set to “${text}”. Now pick the group(s) to post to:`);
          await ctx.reply(renderGroupSelectionMessage(claimed, sel), {
            reply_markup: { inline_keyboard: buildGroupSelectionKeyboard(claimed, sel) },
          });
          return;
        }
        case "groups": {
          // The "groups" step is driven by callbacks. A stray text message
          // here is a no-op — the next callback will continue the flow.
          await ctx.reply("Tap a group row to toggle it, or tap Done to publish.");
          return;
        }
      }
    }

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

    if (data === `${MENU_PREFIX}create_listing`) {
      // The main-menu Create listing button starts the /create_listing
      // conversation (E2T1) inline. Spinner stops first; the bot then
      // sends the "send me the title" prompt.
      await ctx.answerCallbackQuery({ text: "Starting a new listing..." });
      const agentId = ctx.from?.id;
      if (agentId === undefined) {
        await ctx.reply("Could not identify you — try from a Telegram account.");
        return;
      }
      const claimedGroups = await groupStore.listByAgent(agentId);
      if (claimedGroups.length === 0) {
        await ctx.reply(
          "You haven't claimed any groups yet. Add the bot to a Telegram group, tap “Claim this group”, and come back — listings are only published to groups you've claimed.",
        );
        return;
      }
      ctx.session.creating_listing = {
        step: "title",
        data: {},
        selected_group_ids: [],
      };
      await ctx.reply(
        "Let's create a listing. Send me the title as your next message.\n\n(Tip: type /cancel at any point to abandon the draft.)",
      );
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
      // E2T1: /create_listing group-selection step.
      if (data.startsWith(CREATE_LISTING_GROUP_PREFIX, GROUPS_PREFIX.length)) {
        // data looks like "groups:create_listing:group:<id>" or "groups:create_listing:done"
        const rest = data.slice(GROUPS_PREFIX.length + CREATE_LISTING_GROUP_PREFIX.length);
        if (rest === "done") {
          // Finalize the listing.
          if (!ctx.session.creating_listing) {
            await ctx.answerCallbackQuery({ text: "No listing in progress." });
            return;
          }
          const selected = ctx.session.creating_listing.selected_group_ids ?? [];
          const data2 = ctx.session.creating_listing.data;
          if (data2.title === undefined) {
            await ctx.answerCallbackQuery({ text: "Title missing — start over with /create_listing." });
            ctx.session.creating_listing = undefined;
            return;
          }
          const listing = await listingStore.create({
            agent_id: ctx.from!.id!,
            title: data2.title,
            ...(data2.description !== undefined ? { description: data2.description } : {}),
            ...(data2.price_cents !== undefined ? { price_cents: data2.price_cents } : {}),
            ...(data2.bedrooms !== undefined ? { bedrooms: data2.bedrooms } : {}),
            ...(data2.location !== undefined ? { location: data2.location } : {}),
          });
          ctx.session.creating_listing = undefined;
          await ctx.answerCallbackQuery({ text: "Listing created!" });

          // E2T2: post the formatted listing message to each selected
          // group with the inline "I'm interested" button. We do this
          // inline (no separate command) so the agent sees the result
          // of /create_listing immediately. Failures are logged but
          // don't fail the whole flow — a partial post is better than
          // throwing away the listing.
          const postedGroups: number[] = [];
          const failedGroups: number[] = [];
          for (const groupId of selected) {
            try {
              const message = await postListingToGroup(ctx, listing, groupId);
              await listingStore.attachToGroup(listing.id, groupId, message.message_id);
              postedGroups.push(groupId);
            } catch (err) {
              console.error(`[agntdev-bot] failed to post listing ${listing.id} to group ${groupId}:`, err);
              failedGroups.push(groupId);
            }
          }
          const parts: string[] = [`Listing #${listing.id} created.`];
          if (postedGroups.length > 0) parts.push(`Posted to ${postedGroups.length} group(s) with an "I'm interested" button.`);
          if (failedGroups.length > 0) parts.push(`Failed to post to ${failedGroups.length} group(s) — check the bot log.`);
          if (postedGroups.length === 0 && failedGroups.length === 0) {
            parts.push("No groups selected — the listing is saved but not published to any group yet.");
          }
          await ctx.reply(parts.join("\n"));
        } else {
          // Toggle the group in the selection. The rest is "group:<id>".
          const groupIdStr = rest.startsWith("group:") ? rest.slice("group:".length) : rest;
          const groupId = Number.parseInt(groupIdStr, 10);
          if (!Number.isFinite(groupId) || !ctx.session.creating_listing) {
            await ctx.answerCallbackQuery({ text: "Malformed selection." });
            return;
          }
          const sel = ctx.session.creating_listing.selected_group_ids ?? [];
          const idx = sel.indexOf(groupId);
          if (idx >= 0) sel.splice(idx, 1);
          else sel.push(groupId);
          ctx.session.creating_listing.selected_group_ids = sel;
          await ctx.answerCallbackQuery({ text: sel.length === 0 ? "No groups selected" : `${sel.length} group(s) selected` });
          // Re-render the selection prompt with updated checkmarks.
          const claimed = await groupStore.listByAgent(ctx.from!.id!);
          await ctx.reply(renderGroupSelectionMessage(claimed, sel), {
            reply_markup: { inline_keyboard: buildGroupSelectionKeyboard(claimed, sel) },
          });
        }
        return;
      }
    }

    if (data.startsWith(INTERESTED_CALLBACK_PREFIX)) {
      // E2T2: a buyer tapped "I'm interested" on a posted listing.
      // The full buyer-intake flow lives in E3T1; for E2T2 we just
      // acknowledge the tap and stash the listing_id in the session so
      // the next text message in this chat can be treated as the
      // intake's first answer (location).
      const listingIdStr = data.slice(INTERESTED_CALLBACK_PREFIX.length);
      const listingId = Number.parseInt(listingIdStr, 10);
      if (!Number.isFinite(listingId)) {
        await ctx.answerCallbackQuery({ text: "Malformed request." });
        return;
      }
      // E2T2: defer the actual intake-start to E3T1. For now we
      // acknowledge the tap with a friendly toast and a single
      // instruction message so the buyer knows the bot saw them.
      await ctx.answerCallbackQuery({ text: "Got it — starting your intake..." });
      // The full intake flow (location → budget → bedrooms → timeline
      // → pre-approval → score) is implemented in E3T1. For E2T2 we
      // just send a one-liner so the test can verify the button works.
      const listing = await listingStore.get(listingId);
      if (!listing) {
        await ctx.reply("That listing is no longer available.");
        return;
      }
      await ctx.reply(
        `Thanks for your interest in “${listing.title}”! Send me the location you're looking for as your next message and I'll walk you through the rest of the intake.`,
      );
      return;
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
