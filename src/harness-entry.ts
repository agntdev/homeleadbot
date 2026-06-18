import { buildBot } from "./bot.js";

// The Tests-gate harness imports THIS module and calls makeBot() with no args,
// replaying dialog specs tokenlessly (it fakes the Bot API transport — no real
// Telegram call is made). The token is a placeholder for replay. The agntdev-ci
// orchestrator points AGNTDEV_BOT_MODULE at the compiled dist/harness-entry.js.
//
// makeBot() is synchronous: the harness runner (run-specs.ts) calls it without
// awaiting, so the bot must be buildable in one tick. The PostgreSQL migration
// is run by `runMigrationsAndBuildBot()` in production (src/index.ts), NOT here
// — the test harness has no DATABASE_URL anyway and falls through to in-memory
// storage.
export function makeBot() {
  return buildBot(process.env.BOT_TOKEN ?? "harness-test-token");
}
