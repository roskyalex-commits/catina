import { describe, expect, it, vi } from "vitest";
import { CreditLedger, MemoryUsageStore } from "@/lib/enrichment/ledger";
import type { PersonSignalProvider } from "../providers/types";
import type { Signal, SignalScanContext } from "../types";
import { PersonEngagementSignalSource } from "./person-engagement";

/**
 * No provider is connected today, so what is under test is the *seam* — the
 * three rules that have to hold on the day one is bought, when getting them
 * wrong costs real money rather than a failing assertion.
 */

function provider(overrides: Partial<PersonSignalProvider> = {}): PersonSignalProvider {
  return {
    key: "linkedin_engagement",
    label: "LinkedIn",
    costPerCompany: 1,
    pricingNote: "test",
    isConfigured: () => true,
    probe: async () => ({ provider: "linkedin_engagement", configured: true, apiAccessible: true }),
    fetchSignals: async () => [],
    ...overrides,
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "person_engaged_topic",
    title: "Commented on a post about e-factura",
    evidenceUrl: "https://www.linkedin.com/feed/update/1",
    personLinkedinUrl: "https://www.linkedin.com/in/ana-popescu",
    strength: 0.7,
    detectedAt: new Date(),
    dedupeKey: "li:1",
    ...overrides,
  };
}

function context(): SignalScanContext {
  return {
    company: { dedupeKey: "cui:1", name: "EXEMPLU SRL", domain: "exemplu.ro", source: "onrc" },
    keywords: ["e-factura"],
    people: [{ id: "p1", fullName: "Ana Popescu", title: "Director General" }],
  };
}

describe("PersonEngagementSignalSource — availability", () => {
  it("does not apply with no provider connected, which is today", () => {
    const source = new PersonEngagementSignalSource({ providers: [] });
    expect(source.isApplicable(context())).toBe(false);
  });

  it("does not apply when the company has no known people", () => {
    const source = new PersonEngagementSignalSource({ providers: [provider()] });
    expect(source.isApplicable({ ...context(), people: [] })).toBe(false);
  });

  it("applies once a provider, people and something to look for all exist", () => {
    const source = new PersonEngagementSignalSource({ providers: [provider()] });
    expect(source.isApplicable(context())).toBe(true);
  });
});

describe("PersonEngagementSignalSource — spending money", () => {
  it("skips a provider whose monthly budget is spent", async () => {
    const fetchSignals = vi.fn(async () => [signal()]);
    const ledger = new CreditLedger(new MemoryUsageStore({ linkedin_engagement: 1 }), "org-1");
    await ledger.spend("linkedin_engagement", 1);

    const source = new PersonEngagementSignalSource({
      providers: [provider({ fetchSignals })],
      ledger,
    });
    const found = await source.scan(context());

    // An exhausted tier is skipped, not hammered into a 429 — the same rule
    // the email waterfall follows, against the same ledger.
    expect(fetchSignals).not.toHaveBeenCalled();
    expect(found).toEqual([]);
  });

  it("charges for a lookup that came back empty", async () => {
    const store = new MemoryUsageStore({ linkedin_engagement: 10 });
    const ledger = new CreditLedger(store, "org-1");

    const source = new PersonEngagementSignalSource({
      providers: [provider({ fetchSignals: async () => [] })],
      ledger,
    });
    await source.scan(context());

    // The vendor bills for the call, not for the result. A ledger that only
    // counted hits would drift from the invoice.
    expect(await ledger.remaining("linkedin_engagement")).toBe(9);
  });

  it("charges for a lookup that threw, and does not fail the scan", async () => {
    const ledger = new CreditLedger(new MemoryUsageStore({ linkedin_engagement: 10 }), "org-1");
    const source = new PersonEngagementSignalSource({
      providers: [
        provider({
          fetchSignals: async () => {
            throw new Error("vendor 500");
          },
        }),
      ],
      ledger,
    });

    await expect(source.scan(context())).resolves.toEqual([]);
    expect(await ledger.remaining("linkedin_engagement")).toBe(9);
  });

  it("lets one provider fail without losing another's results", async () => {
    const source = new PersonEngagementSignalSource({
      providers: [
        provider({
          key: "broken",
          fetchSignals: async () => {
            throw new Error("down");
          },
        }),
        provider({ key: "working", fetchSignals: async () => [signal()] }),
      ],
    });

    expect(await source.scan(context())).toHaveLength(1);
  });
});

describe("PersonEngagementSignalSource — what a paid source is still not allowed to do", () => {
  it("drops a signal with no evidence link", async () => {
    const source = new PersonEngagementSignalSource({
      providers: [provider({ fetchSignals: async () => [signal({ evidenceUrl: undefined })] })],
    });

    // Paying for the data does not exempt it from the rule that a user can
    // click through to the source. Without a link it is a score, not a signal.
    expect(await source.scan(context())).toEqual([]);
  });

  it("drops a signal that names no person", async () => {
    const source = new PersonEngagementSignalSource({
      providers: [provider({ fetchSignals: async () => [signal({ personLinkedinUrl: undefined })] })],
    });
    expect(await source.scan(context())).toEqual([]);
  });

  it("drops a signal of a type this source does not own", async () => {
    const source = new PersonEngagementSignalSource({
      providers: [provider({ fetchSignals: async () => [signal({ type: "funding_news" })] })],
    });
    expect(await source.scan(context())).toEqual([]);
  });
});
