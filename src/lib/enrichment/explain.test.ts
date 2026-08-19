import { describe, expect, it } from "vitest";
import { explainMiss } from "./explain";

/**
 * These strings are the whole of what a user sees when enrichment finds
 * nothing, and the three common failures need three different responses from
 * them — so a generic message would be worse than no message at all.
 */

describe("explainMiss", () => {
  it("names the missing website, which is the majority case", () => {
    expect(explainMiss({ skipped: "no_domain" })).toMatch(/no website/i);
  });

  it("distinguishes a domain that takes no mail from one we could not check", () => {
    const dead = explainMiss({
      attempts: [{ provider: "mx", outcome: "miss", creditsSpent: 0 }],
    });
    const unknown = explainMiss({
      attempts: [{ provider: "mx", outcome: "error", creditsSpent: 0 }],
    });

    // The first means drop the lead; the second means try again later.
    expect(dead).toMatch(/no mail/i);
    expect(unknown).toMatch(/try again/i);
    expect(dead).not.toBe(unknown);
  });

  it("says a provider is missing when every metered step was skipped", () => {
    const note = explainMiss({
      attempts: [
        { provider: "mx", outcome: "hit", creditsSpent: 0 },
        { provider: "crawler", outcome: "miss", creditsSpent: 0 },
        { provider: "hunter", outcome: "skipped", detail: "not configured", creditsSpent: 0 },
      ],
    });

    expect(note).toMatch(/no lookup provider/i);
  });

  it("distinguishes an exhausted allowance from an absent key", () => {
    const note = explainMiss({
      attempts: [
        { provider: "mx", outcome: "hit", creditsSpent: 0 },
        {
          provider: "hunter",
          outcome: "skipped",
          detail: "monthly free-tier allowance exhausted",
          creditsSpent: 0,
        },
      ],
    });

    // Connecting another key fixes one of these and not the other.
    expect(note).toMatch(/used up/i);
  });

  it("falls back to something true rather than something vague", () => {
    const note = explainMiss({
      attempts: [
        { provider: "mx", outcome: "hit", creditsSpent: 0 },
        { provider: "hunter", outcome: "miss", detail: "no people returned", creditsSpent: 1 },
      ],
    });

    expect(note).toMatch(/no address found/i);
  });
});
