import { describe, expect, it } from "vitest";
import { scoreLead } from "../src/storage/scoring";

describe("scoreLead (E3T2) — spec rules", () => {
  // A: pre_approved == "yes" AND timeline == "30d" — the only hot tier.
  it("A: pre-approved AND 30d timeline", () => {
    expect(scoreLead({ pre_approval: "yes", timeline: "30d" })).toBe("A");
  });

  // B (warm): pre-approved OR (≤ 90 days), but NOT A.
  it("B: pre-approved but 1-3m timeline", () => {
    expect(scoreLead({ pre_approval: "yes", timeline: "1-3m" })).toBe("B");
  });
  it("B: pre-approved but 3-6m timeline", () => {
    expect(scoreLead({ pre_approval: "yes", timeline: "3-6m" })).toBe("B");
  });
  it("B: pre-approved but 6m+ timeline", () => {
    expect(scoreLead({ pre_approval: "yes", timeline: "6m+" })).toBe("B");
  });
  it("B: not pre-approved but 30d timeline", () => {
    expect(scoreLead({ pre_approval: "no", timeline: "30d" })).toBe("B");
  });
  it("B: 'looking' pre-approval but 1-3m timeline", () => {
    expect(scoreLead({ pre_approval: "looking", timeline: "1-3m" })).toBe("B");
  });
  it("B: missing pre-approval but 1-3m timeline", () => {
    expect(scoreLead({ timeline: "1-3m" })).toBe("B");
  });

  // C (cold): neither condition met.
  it("C: not pre-approved AND 3-6m timeline", () => {
    expect(scoreLead({ pre_approval: "no", timeline: "3-6m" })).toBe("C");
  });
  it("C: not pre-approved AND 6m+ timeline", () => {
    expect(scoreLead({ pre_approval: "no", timeline: "6m+" })).toBe("C");
  });
  it("C: looking AND 6m+ timeline", () => {
    expect(scoreLead({ pre_approval: "looking", timeline: "6m+" })).toBe("C");
  });
  it("C: missing pre-approval AND 6m+ timeline", () => {
    expect(scoreLead({ timeline: "6m+" })).toBe("C");
  });

  // Conservative default: missing / unknown inputs default to C
  // (matches the spec's "everything else" catch-all).
  it("C: both fields missing", () => {
    expect(scoreLead({})).toBe("C");
  });
  it("C: both fields undefined", () => {
    expect(scoreLead({ pre_approval: undefined, timeline: undefined })).toBe("C");
  });
  it("C: pre-approval is a free-text stray (not one of the known values)", () => {
    expect(scoreLead({ pre_approval: "maybe", timeline: "30d" })).toBe("B"); // timeline wins
    expect(scoreLead({ pre_approval: "maybe", timeline: "6m+" })).toBe("C");
  });
});
