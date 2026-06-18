# AGENTS.md — AGNTDEV Telegram bot

A grammY Telegram bot. The AGNTDEV bot toolkit (curated grammY SDK + UI-kit + session storage + test harness) is vendored in `src/toolkit/`. You implement ONE task at
a time so it passes the Tests-gate and merges.

## Setup / build / run
```bash
npm install
npm run build     # tsc -p tsconfig.json → dist/
npm start         # node dist/index.js (needs BOT_TOKEN)
```

## Structure (extend these — do not rearchitect)
- `src/bot.ts` — `buildBot(token)`: assembles the bot + registers handlers, does
  NOT start it. **Add new commands and flows here.**
- `src/index.ts` — runtime entry (reads `BOT_TOKEN`, starts the bot).
- `src/harness-entry.ts` — exports `makeBot()` for the Tests-gate (tokenless replay).
- `tests/specs/<slug>.json` — per-feature dialog tests (a `BotSpec` array).
- `tests/commands/<slug>.json` — per-feature declared-command manifest (a JSON string array).

## ⚠️ Explicit `.js` import extensions
This is an ESM (`NodeNext`) project. Relative imports MUST carry the `.js`
extension (`import { buildBot } from "./bot.js"`), even from `.ts` files — Node's
runtime requires it. A missing extension can typecheck yet crash at runtime.

## Tests
Each feature writes its OWN `tests/specs/<slug>.json` (a `BotSpec` array: steps of
`{ send, expect }`, where `expect` payloads match as a subset) AND, if it adds a
command, its OWN `tests/commands/<slug>.json` (a JSON string array, e.g.
`["/start"]`). NEVER edit a shared `tests/specs.json` / `tests/commands.json` —
concurrent PRs would conflict. The gate globs `tests/specs/*.json` +
`tests/commands/*.json`.

## Implementation contract (a stub is a FAILURE, even if it compiles)
- **No stubs:** no empty bodies, `TODO`/`FIXME`, commented-out logic, or
  `throw new Error("not implemented")`.
- **No fake data:** no `Math.random()`, hardcoded sample arrays, or canned
  responses standing in for real computed/fetched values.
- **No in-memory data store:** a `Map`/array/module-level variable used as a
  database is a defect. Durable data (anything that must survive a restart) MUST
  use the toolkit's persistent storage (Redis-backed) — not process memory. The
  `Session` type and session storage are for ephemeral conversation state only.
- **Real integrations:** call external APIs against their real contract (correct
  endpoints, ids and params — e.g. a coin *id*, not a ticker), with credentials
  from env.
- **Wire it up:** new commands/handlers must be registered in `buildBot` and
  reachable.

If a task is under-specified, implement the smallest REAL slice you can verify
and note the gap — never fake behavior to make the PR look complete.
