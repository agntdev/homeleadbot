/**
 * Lead scoring (E3T2). Pure functions — no DB, no I/O — so the test
 * harness can assert every cell of the truth table in a few ms and the
 * bot can call into the same module from the intake completion handler.
 *
 * Rules (per the project spec at docs/spec.md):
 *   A (hot)     — pre_approved == "yes" AND timeline == "30d"
 *   B (warm)    — (pre_approved == "yes" OR timeline in {30d, 1-3m})
 *                 AND NOT A
 *   C (cold)    — everything else
 *
 * Unknown / missing values default to the "no" / "long" side so a
 * buyer who skipped both fields is treated as C (matches the spec's
 * "everything else").
 */

export type LeadScore = "A" | "B" | "C";

/** Subset of LeadIntakeItem values that drive the score. */
export interface ScoreInputs {
  pre_approval?: string;
  timeline?: string;
}

/**
 * scoreLead — pure function that maps a (pre_approval, timeline) pair to
 * an A/B/C tier. Returns "C" for unknown / missing inputs (the
 * conservative default — a buyer who skipped the pre-approval and
 * timeline questions is treated as cold by spec).
 */
export function scoreLead(input: ScoreInputs): LeadScore {
  const isPreApproved = input.pre_approval === "yes";
  // Timeline buckets that count as "≤ 90 days" per the spec.
  const isShortTimeline = input.timeline === "30d" || input.timeline === "1-3m";

  // A: hot — both conditions met.
  if (isPreApproved && input.timeline === "30d") return "A";

  // B: warm — at least one condition met, but not A.
  if (isPreApproved || isShortTimeline) return "B";

  // C: cold — neither condition met.
  return "C";
}
