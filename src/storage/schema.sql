-- HomeLeadBot PostgreSQL schema (E5T1).
-- Applied idempotently on bot startup via runMigration() (src/storage/migrate.ts).
-- Every CREATE uses IF NOT EXISTS so re-running the migration is safe.

-- agents: real estate agents who have /started the bot. Source of truth for
-- "who is an agent" and who receives lead notifications.
CREATE TABLE IF NOT EXISTS agents (
  telegram_id   BIGINT PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  username      TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- groups: Telegram groups the bot has been added to (regardless of claim state).
-- group_claims (below) tracks who claimed each group for lead routing.
CREATE TABLE IF NOT EXISTS groups (
  group_id BIGINT PRIMARY KEY,
  title    TEXT,
  type     TEXT NOT NULL
);

-- group_claims: one row per Telegram group that an agent has claimed via the
-- "Claim this group" button (E1T2). The composite primary key is just group_id
-- (one claim per group). claimed_by is a foreign key to agents.
CREATE TABLE IF NOT EXISTS group_claims (
  group_id   BIGINT PRIMARY KEY REFERENCES groups(group_id) ON DELETE CASCADE,
  claimed_by BIGINT      NOT NULL REFERENCES agents(telegram_id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- listings: properties an agent has created via /create_listing (E2).
-- A listing can be posted to multiple groups (see group_listings).
CREATE TABLE IF NOT EXISTS listings (
  id          SERIAL PRIMARY KEY,
  agent_id    BIGINT      NOT NULL REFERENCES agents(telegram_id),
  title       TEXT        NOT NULL,
  description TEXT,
  price_cents BIGINT,
  bedrooms    INTEGER,
  location    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- group_listings: which listings were posted to which groups, and the
-- Telegram message_id of the posted message (so the "I'm interested"
-- callback can route back to the listing).
CREATE TABLE IF NOT EXISTS group_listings (
  listing_id  INTEGER   NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  group_id    BIGINT    NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  message_id  BIGINT,
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (listing_id, group_id)
);

-- leads: buyer interest captured from the "I'm interested" button (E3) or
-- direct messages to the bot. status drives the lifecycle; score is the
-- A/B/C lead tier.
CREATE TABLE IF NOT EXISTS leads (
  id                SERIAL PRIMARY KEY,
  listing_id        INTEGER REFERENCES listings(id) ON DELETE SET NULL,
  group_id          BIGINT  REFERENCES groups(group_id) ON DELETE SET NULL,
  buyer_telegram_id BIGINT  NOT NULL,
  buyer_username    TEXT,
  buyer_display_name TEXT,
  status            TEXT    NOT NULL DEFAULT 'new',
  score             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contacted_at TIMESTAMPTZ
);

-- lead_intake_items: the structured answers collected during the buyer
-- intake flow (location, budget, bedrooms, timeline, pre-approval).
CREATE TABLE IF NOT EXISTS lead_intake_items (
  id       SERIAL PRIMARY KEY,
  lead_id  INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  question TEXT    NOT NULL,
  answer   TEXT    NOT NULL,
  position INTEGER NOT NULL
);

-- lead_events: append-only audit log of everything that happens to a lead
-- (created, scored, contacted, marked not-a-fit, follow-up sent, etc.).
-- Used by the admin UI and the follow-up scheduler (E4T3).
CREATE TABLE IF NOT EXISTS lead_events (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT    NOT NULL,
  event_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- followup_jobs: scheduled 24-hour nudges (E4T3) and any future scheduled
-- messages. The scheduler scans for status='pending' AND scheduled_at <= NOW().
CREATE TABLE IF NOT EXISTS followup_jobs (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the hot read paths. Cheap insurance now; big win when the
-- tables grow.
CREATE INDEX IF NOT EXISTS idx_listings_agent      ON listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_buyer         ON leads(buyer_telegram_id);
CREATE INDEX IF NOT EXISTS idx_leads_listing       ON leads(listing_id);
CREATE INDEX IF NOT EXISTS idx_leads_group         ON leads(group_id);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead    ON lead_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_followup_pending    ON followup_jobs(status, scheduled_at);
