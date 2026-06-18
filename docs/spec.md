## Summary
A Telegram bot for real estate agents that captures and qualifies buyer leads. Buyers trigger a short intake (location, budget, bedrooms, timeline, pre-approval). Leads are scored A/B/C; A (hot) leads — defined as pre-approved AND timeline ≤ 30 days — immediately notify the agent (group + DM) with the buyer’s Telegram username and full intake. Agents create and post listings through the bot into groups the bot is added to; buyer taps “I'm interested” on a listing to start the qualification flow. The bot runs a 24-hour automated follow-up to re-engage leads that go cold. Free, single-tier service.

## Audience
- Primary: individual real estate agents or small teams who operate via Telegram groups and want immediate, qualified buyer leads.
- Secondary: buyers interacting with listings in Telegram groups or messaging the bot directly.

## Core entities
- Agent: Telegram user who signs up and claims a group; receives lead notifications.
- Group binding: a Telegram group that an agent claims and connects for notifications.
- Listing: property posted via the bot, published to one or more Telegram groups with an “I'm interested” button.
- Lead / Intake: buyer session capturing: location, budget (min/max or max), bedrooms, timeline, pre-approval (Yes/No/Looking), buyer’s Telegram username, session metadata.
- Lead score: A, B, C (scoring rules below).
- Follow-up task: scheduled reminder/messages to buyer at 24 hours if lead is cold.

## Integrations & notification targets
- Telegram Bot API (primary integration). Use a robust framework (e.g., Telegraf) to manage commands, inline keyboards, messages, and callbacks.
- Notification targets:
  - Primary: the Telegram group the agent claims (the bot posts lead messages there).
  - Secondary: direct message (DM) to the claiming agent’s Telegram account for A leads.
- Persistence/storage: PostgreSQL (relational schema for agents, groups, listings, leads, scheduled follow-ups).
- Hosting: containerized Node.js service (or equivalent) with a job scheduler (e.g., cron + worker or Bull/Redis) to handle follow-ups and retries.

## Interaction flows
1) Agent onboarding & group claim
   - Agent sends /start to bot in private chat.
   - Bot registers agent account (Telegram ID, display name).
   - To connect a group: owner adds the bot to the group; when added the bot auto-detects group addition and auto-prompts the group’s admins via the bot (in the group or DM) to claim
     - Admin confirms with an inline button "Claim this group"; claiming admin becomes the agent contact for that group.
   - The agent may rename or detach the group via /groups management commands.

2) Agent creates & posts a listing
   - Agent uses /create_listing in private chat with bot. Bot collects listing title, short description, price, key details and which claimed group(s) to publish to.
   - Bot publishes a formatted message into the selected group(s) with an inline button "I'm interested" (callback).
   - Rationale: Controlled bot posting ensures the interest button and intake flow are attached reliably.

3) Buyer expresses interest (group listing)
   - Buyer taps "I'm interested" in group message (or messages bot directly).
   - Bot starts the intake conversation (private chat with buyer). Intake questions (short, quick replies where applicable):
     - Location (city / ZIP / free text)
     - Budget (max or range)
     - Bedrooms (numeric or options)
     - Timeline (options: ≤30 days, 1–3 months, 3–6 months, 6+ months)
     - Pre-approval (Yes / No / Looking)
   - Bot captures buyer’s Telegram username (@username). No phone/email is requested or stored.
   - Bot computes lead score.

4) Lead scoring & notifications
   - A (hot): pre-approved == Yes AND timeline == ≤30 days. Immediate actions:
     - Post a lead message into the agent’s claimed group with full intake and buyer Telegram username.
     - Send a DM to the claiming agent with a copy of the intake and quick action buttons ("Contact buyer" — opens buyer profile, "Mark contacted").
   - B (warm): either pre-approved OR timeline ≤ 90 days but not both A conditions. Action:
     - Store lead and send daily digest of warm leads to the agent (configurable later); do NOT immediate-ping unless agent preferences change.
   - C (cold/long timeline): everything else. Action:
     - Store lead for records; optional weekly digest (future enhancement).

5) 24-hour follow-up
   - For any lead that was not marked "contacted" by the agent within 24 hours, the bot sends an automated nudge message to the buyer (private chat) to re-confirm interest and offers to reconnect the agent.
   - If buyer re-engages, update lead timestamp and re-evaluate score; reroute to agent if escalated.

6) Lead lifecycle & agent actions
   - Agent can mark lead statuses via inline buttons in the lead message (Contacted, Not a fit, Follow up later).
   - All status changes are stored and used to suppress follow-ups and deduplicate notifications.

## Persistence
- PostgreSQL tables: agents, groups, group_claims, listings, leads, lead_intake_items, lead_events, followup_jobs.
- Store timestamps (created_at, last_contacted_at), lead source (group/listing/direct), listing_id, and Telegram IDs for buyer and agent.
- Retain leads for 12 months by default (configurable). Backups and export endpoints for agent access.

## Payments
- Free for now. No payment or billing integration in scope.

## Non-goals
- Not a full CRM (no calendar scheduling, no phone/email capture, no multi-agent routing beyond single claiming admin per group in v1).
- No SMS/Email outreach — Telegram-only interactions in v1.
- No advanced lead scoring with external data sources in v1.

## Assumptions & defaults
- Agent listing workflow: agents create listings via /create_listing in private chat; bot posts into chosen groups with "I'm interested" button — rationale: ensures the bot can attach the callback/intake flow reliably.
- Lead contact: only use buyer's Telegram username (@username) and Telegram display name; no phone/email collected — per owner preference.
- Hot lead rule: "A" = pre-approved == Yes AND timeline ≤ 30 days (as provided). Rationale: owner-specified trigger.
- Warm/cold scoring default: B = pre-approved but timeline >30 days up to 90 days OR not pre-approved but timeline ≤90 days; C = all others — rationale: provides sensible tiering so only clearly hot leads are escalated immediately.
- Notifications: immediate A lead notifications go to the claimed group AND directly to the claiming agent via DM — rationale: ensures visibility in-group and direct alert.
- Group claim flow: bot auto-prompts group admins upon being added; first admin to press "Claim this group" becomes the agent for that group — rationale: simple ownership model and matches owner instruction.
- Follow-up scheduling: 24 hours after lead creation if not marked contacted; follow-up message is one automated nudge — rationale: matches owner requirement and minimizes spam.
- Storage & hosting defaults: PostgreSQL for persistence, Node.js + Telegraf for the bot, background worker (Redis/Bull) for scheduling — rationale: common, reliable stack for Telegram bots.
- Retention: keep lead records 12 months by default unless the agent requests exports/cleanup — rationale: reasonable balance of usefulness and privacy.

If you want any of the defaults changed (e.g., have the bot detect forwarded listing messages instead of controlled publishing, require additional lead fields, or route leads to multiple agents), say which default to override and I will produce an updated brief.