import type { ListingStore } from "./listings.js";
import type { LeadStore } from "./leads.js";
import type { FollowupStore } from "./followup-jobs.js";

/** Default retention window per the project spec: 12 months. */
export const DEFAULT_RETENTION_DAYS = 365;

export interface RetentionHandles {
  listings: ListingStore;
  leads: LeadStore;
  followups: FollowupStore;
}

export interface RetentionResult {
  listingsDeleted: number;
  leadsDeleted: number;
  followupsDeleted: number;
  /** Total rows purged across every store. */
  total: number;
  retentionDays: number;
  ranAt: string;
}

/**
 * runRetentionPolicy — purge rows older than `retentionDays` (default
 * 12 months per the project spec) from listings, leads, and
 * completed (sent/cancelled) follow-up jobs. Returns the per-store and
 * total deletion counts for logging/metrics.
 *
 * Intended to be called by a daily cron / scheduler (the platform
 * surfaces this; E4T3 wires the actual schedule). The function is
 * idempotent and safe to run more often than the configured cadence.
 */
export async function runRetentionPolicy(
  handles: RetentionHandles,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<RetentionResult> {
  const [listingsDeleted, leadsDeleted, followupsDeleted] = await Promise.all([
    handles.listings.purgeOlderThanDays(retentionDays),
    handles.leads.purgeOlderThanDays(retentionDays),
    handles.followups.purgeOlderThanDays(retentionDays),
  ]);
  return {
    listingsDeleted,
    leadsDeleted,
    followupsDeleted,
    total: listingsDeleted + leadsDeleted + followupsDeleted,
    retentionDays,
    ranAt: new Date().toISOString(),
  };
}
