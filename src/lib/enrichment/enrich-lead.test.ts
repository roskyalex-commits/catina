import { describe, expect, it, vi } from "vitest";
import type { ScoreBreakdown } from "@/lib/signals/scoring";
import { enrichLead, type EnrichableLead } from "./enrich-lead";
import { CreditLedger, MemoryUsageStore } from "./ledger";
import type { MxChecker } from "./mx";
import { EmailWaterfall } from "./waterfall";

/**
 * What matters here is not the waterfall — that has its own tests — but the
 * three things wrapped around it: that a crawl actually feeds the free step,
 * that a lead is never enriched twice by accident, and that the score moves.
 *
 * The last one is the whole point of the feature. A lead that comes back with
 * an address and the same score has not been enriched in any sense the user
 * cares about.
 */

/** A lead as it exists today: perfect ICP fit, no signals, no email. */
function breakdownAt45(): ScoreBreakdown {
  return {
    total: 45,
    icpFit: { score: 1, weight: 0.45, reasons: [] },
    signals: { score: 0, weight: 0.35, reasons: [] },
    contactability: { score: 0, weight: 0.2, reasons: [{ label: "No email address found", points: 0 }] },
    penalties: { total: 0, reasons: [] },
  };
}

function lead(overrides: Partial<EnrichableLead> = {}): EnrichableLead {
  return {
    id: "lead-1",
    personId: "person-1",
    companyId: "company-1",
    fullName: "Ana Popescu",
    companyName: "TECHNOPILOT SRL",
    domain: "technopilot.ro",
    breakdown: breakdownAt45(),
    enrichedAt: null,
    ...overrides,
  };
}

function fakeMx(acceptsMail = true) {
  return {
    check: vi.fn(async (domain: string) => ({
      domain,
      acceptsMail,
      hosts: acceptsMail ? ["aspmx.l.google.com"] : [],
      isFreeProvider: false,
      provider: "google" as const,
    })),
  } as unknown as MxChecker;
}

function waterfall(mx = fakeMx()) {
  return new EmailWaterfall({
    ledger: new CreditLedger(new MemoryUsageStore(), "org-1"),
    mx,
    providers: [],
  });
}

describe("enrichLead — the free path", () => {
  it("feeds the crawled role address into the waterfall", async () => {
    const roleEmails = vi.fn(async () => ["office@technopilot.ro"]);

    const outcome = await enrichLead({ waterfall: waterfall(), roleEmails }, lead());

    expect(roleEmails).toHaveBeenCalledWith("technopilot.ro");
    expect(outcome.email?.address).toBe("office@technopilot.ro");
    expect(outcome.email?.provider).toBe("crawler");
    expect(outcome.email?.isRoleAddress).toBe(true);
  });

  it("lifts the score, which is the entire point", async () => {
    const outcome = await enrichLead(
      { waterfall: waterfall(), roleEmails: async () => ["office@technopilot.ro"] },
      lead(),
    );

    // 45 is the ceiling with no email; a role address must clear it.
    expect(outcome.scoreBefore).toBe(45);
    expect(outcome.scoreAfter).toBeGreaterThan(45);
    expect(outcome.breakdown.contactability.score).toBeGreaterThan(0);
  });

  it("leaves the other components exactly as they were", async () => {
    const before = breakdownAt45();
    const outcome = await enrichLead(
      { waterfall: waterfall(), roleEmails: async () => ["office@technopilot.ro"] },
      lead({ breakdown: before }),
    );

    // Enrichment learned nothing about fit or signals, so re-deriving them
    // could only introduce drift.
    expect(outcome.breakdown.icpFit).toEqual(before.icpFit);
    expect(outcome.breakdown.signals).toEqual(before.signals);
  });

  it("survives a site that cannot be crawled", async () => {
    const outcome = await enrichLead(
      {
        waterfall: waterfall(),
        roleEmails: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
      lead(),
    );

    // Most prospect sites are down, JS-only or blocking us. That is an empty
    // result, not an exception the caller can act on.
    expect(outcome.email).toBeNull();
    expect(outcome.skipped).toBeUndefined();
  });
});

describe("enrichLead — when it declines to run", () => {
  it("skips a lead with no domain without crawling anything", async () => {
    const roleEmails = vi.fn(async () => []);

    const outcome = await enrichLead(
      { waterfall: waterfall(), roleEmails },
      lead({ domain: null }),
    );

    expect(outcome.skipped).toBe("no_domain");
    expect(roleEmails).not.toHaveBeenCalled();
    expect(outcome.scoreAfter).toBe(outcome.scoreBefore);
  });

  it("skips a lead a previous run already answered", async () => {
    const roleEmails = vi.fn(async () => ["office@technopilot.ro"]);

    const outcome = await enrichLead(
      { waterfall: waterfall(), roleEmails },
      lead({ enrichedAt: new Date("2026-08-01") }),
    );

    // A miss is the common case, so re-running the whole set would spend the
    // month's budget re-asking questions that already came back empty.
    expect(outcome.skipped).toBe("already_tried");
    expect(roleEmails).not.toHaveBeenCalled();
  });

  it("re-runs that lead when explicitly forced", async () => {
    const outcome = await enrichLead(
      { waterfall: waterfall(), roleEmails: async () => ["office@technopilot.ro"] },
      lead({ enrichedAt: new Date("2026-08-01") }),
      { force: true },
    );

    expect(outcome.skipped).toBeUndefined();
    expect(outcome.email?.address).toBe("office@technopilot.ro");
  });

  it("reports a domain that accepts no mail rather than guessing at it", async () => {
    const outcome = await enrichLead(
      { waterfall: waterfall(fakeMx(false)), roleEmails: async () => [] },
      lead(),
    );

    expect(outcome.email).toBeNull();
    expect(outcome.attempts).toContainEqual(
      expect.objectContaining({ provider: "mx", outcome: "miss" }),
    );
    expect(outcome.scoreAfter).toBe(45);
  });
});

describe("enrichLead — restraint", () => {
  it("does not reach a vendor once a role address is in hand", async () => {
    const findPeople = vi.fn(async () => []);
    const chain = new EmailWaterfall({
      ledger: new CreditLedger(new MemoryUsageStore({ hunter: 25 }), "org-1"),
      mx: fakeMx(),
      providers: [
        {
          key: "hunter",
          label: "Hunter",
          freeTierNote: "",
          isConfigured: () => true,
          probe: async () => ({ provider: "hunter", configured: true, apiAccessible: true }),
          findPeople,
        },
      ],
    });

    await enrichLead(
      { waterfall: chain, roleEmails: async () => ["office@technopilot.ro"] },
      lead(),
    );

    // Hunter's free tier is 25 searches a month. Spending one to improve a
    // lead we can already reach is the wrong use of a scarce resource.
    expect(findPeople).not.toHaveBeenCalled();
  });
});
