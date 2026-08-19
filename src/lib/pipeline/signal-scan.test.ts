import { describe, expect, it, vi } from "vitest";
import type { SiteSnapshot } from "@/lib/crawl/fetch-site";
import type { Signal, SignalScanContext, SignalSource } from "@/lib/signals/types";
import {
  MAX_CONSECUTIVE_FAILURES,
  emptyTargeting,
  scanRun,
  type ScanCandidate,
  type ScanRunDeps,
} from "./signal-scan";
import type { RegistryCompany } from "./source-run";

/**
 * What matters here is not the sources — they have their own tests — but the
 * things wrapped around them: that the site is read once however many sources
 * want it, that one broken company does not take the page down, that a site
 * which is down repeatedly stops being asked, and that an unreachable scan does
 * not erase the state the next diff depends on.
 */

function company(overrides: Partial<RegistryCompany> = {}): RegistryCompany {
  return {
    id: "company-1",
    dedupeKey: "cui:123",
    name: "TECHNOPILOT SRL",
    domain: "technopilot.ro",
    country: "RO",
    cui: "123",
    source: "onrc",
    ...overrides,
  };
}

function candidate(overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return { company: company(), people: [], ...overrides };
}

function snapshot(techStack: string[] = ["WordPress"]): SiteSnapshot {
  return {
    domain: "technopilot.ro",
    origin: "https://technopilot.ro",
    pages: [{ url: "https://technopilot.ro/", title: "Home", text: "x".repeat(300) }],
    techStack,
    roleEmails: [],
    socialLinks: {},
  };
}

/** A source that records how many times it read the site. */
function siteReadingSource(key: string, reads: { count: number }): SignalSource {
  return {
    key,
    label: key,
    description: "",
    isApplicable: () => true,
    async scan(context: SignalScanContext) {
      await context.site?.();
      reads.count += 1;
      return [];
    },
  };
}

function emittingSource(signal: Signal): SignalSource {
  return {
    key: "emitter",
    label: "emitter",
    description: "",
    isApplicable: () => true,
    scan: async () => [signal],
  };
}

function deps(overrides: Partial<ScanRunDeps> & { candidates?: ScanCandidate[] } = {}): ScanRunDeps {
  const candidates = overrides.candidates ?? [candidate()];
  return {
    findCandidates: overrides.findCandidates ?? (async () => ({ candidates, cursor: "c1", notes: [] })),
    sources: overrides.sources ?? (() => []),
    fetchSite: overrides.fetchSite ?? (async () => snapshot()),
  };
}

describe("scanRun — the shared site read", () => {
  it("fetches a company's site once however many sources ask for it", async () => {
    const fetchSite = vi.fn(async () => snapshot());
    const reads = { count: 0 };

    await scanRun(
      deps({
        sources: () => [
          siteReadingSource("a", reads),
          siteReadingSource("b", reads),
          siteReadingSource("c", reads),
        ],
        fetchSite,
      }),
      { targeting: emptyTargeting() },
    );

    // Three sources asked; one HTTP read happened. Before this, the tech-stack
    // and pricing sources alone made twelve requests per company.
    expect(reads.count).toBe(3);
    expect(fetchSite).toHaveBeenCalledTimes(1);
  });

  it("does not fetch anything for a company with no domain", async () => {
    const fetchSite = vi.fn(async () => snapshot());
    const reads = { count: 0 };

    const result = await scanRun(
      deps({
        candidates: [candidate({ company: company({ domain: undefined }) })],
        sources: () => [siteReadingSource("a", reads)],
        fetchSite,
      }),
      { targeting: emptyTargeting() },
    );

    expect(fetchSite).not.toHaveBeenCalled();
    // And it is not "unreachable" — it was never going to be read, and marking
    // it failed would back it off forever for a reason it cannot fix.
    expect(result.results[0].status).toBe("ok");
    expect(result.results[0].consecutiveFailures).toBe(0);
  });
});

describe("scanRun — failure isolation and backoff", () => {
  it("keeps going when one company's scan throws", async () => {
    const exploding: SignalSource = {
      key: "boom",
      label: "boom",
      description: "",
      // SignalScanContext carries a SourcedCompany, which has no id — the
      // pipeline adds one. Match on the name, which the source does see.
      isApplicable: (context) => context.company.name === "OTHER SRL",
      scan: async () => {
        throw new Error("upstream on fire");
      },
    };

    const result = await scanRun(
      deps({
        candidates: [
          candidate(),
          candidate({ company: company({ id: "company-2", name: "OTHER SRL" }) }),
          candidate({ company: company({ id: "company-3", name: "THIRD SRL" }) }),
        ],
        sources: () => [exploding],
      }),
      { targeting: emptyTargeting() },
    );

    // SignalScanner isolates the throw, so the company survives with an error
    // recorded against that source and the page completes.
    expect(result.results).toHaveLength(3);
    const failed = result.results.find((r) => r.companyId === "company-2")!;
    expect(failed.sourceResults.some((s) => s.status === "error")).toBe(true);
  });

  it("marks a company unreachable when its site could not be read", async () => {
    const reads = { count: 0 };
    const result = await scanRun(
      deps({ sources: () => [siteReadingSource("a", reads)], fetchSite: async () => null }),
      { targeting: emptyTargeting() },
    );

    expect(result.results[0].status).toBe("unreachable");
    expect(result.results[0].consecutiveFailures).toBe(1);
  });

  it("stops asking a site that has failed too many times", async () => {
    const fetchSite = vi.fn(async () => snapshot());

    const result = await scanRun(
      deps({
        candidates: [candidate({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES })],
        fetchSite,
      }),
      { targeting: emptyTargeting() },
    );

    expect(result.backedOff).toBe(1);
    expect(result.results).toHaveLength(0);
    expect(fetchSite).not.toHaveBeenCalled();
  });

  it("resets the failure count once a site comes back", async () => {
    const result = await scanRun(
      deps({ candidates: [candidate({ consecutiveFailures: 2 })] }),
      { targeting: emptyTargeting() },
    );

    expect(result.results[0].consecutiveFailures).toBe(0);
  });
});

describe("scanRun — the state the next diff needs", () => {
  it("records the tech stack a first scan found", async () => {
    const result = await scanRun(
      deps({ fetchSite: async () => snapshot(["WordPress", "Stripe"]) }),
      { targeting: emptyTargeting() },
    );

    expect(result.results[0].state.techStack).toEqual(["WordPress", "Stripe"]);
  });

  it("carries the previous stack forward when the site is unreachable", async () => {
    const result = await scanRun(
      deps({
        candidates: [candidate({ previous: { techStack: ["Shopify"] } })],
        fetchSite: async () => null,
      }),
      { targeting: emptyTargeting() },
    );

    // Erasing it would make every technology look newly added on the next scan
    // that succeeds — a burst of false signals caused by one outage.
    expect(result.results[0].state.techStack).toEqual(["Shopify"]);
  });

  it("stores the pricing hash a signal reported, so the next scan can diff", async () => {
    const result = await scanRun(
      deps({
        sources: () => [
          emittingSource({
            type: "pricing_page_changed",
            title: "Pricing page changed",
            strength: 0.5,
            detectedAt: new Date(),
            dedupeKey: "pricing:technopilot.ro:abc",
            payload: { currentHash: "abc123", pricingPageUrl: "https://technopilot.ro/preturi" },
          }),
        ],
      }),
      { targeting: emptyTargeting() },
    );

    expect(result.results[0].state.pricingPageHash).toBe("abc123");
    expect(result.results[0].state.pricingPageUrl).toBe("https://technopilot.ro/preturi");
  });

  it("copies the revenue figures from the row, not from a live read", async () => {
    const result = await scanRun(
      deps({
        candidates: [
          candidate({ company: company({ revenueRon: 1_000_000, vatRegistered: true }) }),
        ],
      }),
      { targeting: emptyTargeting() },
    );

    // The next scan must diff against what *this* scan saw. Reading the company
    // row live at diff time compares a value with itself and never fires.
    expect(result.results[0].state.revenueRon).toBe(1_000_000);
    expect(result.results[0].state.vatRegistered).toBe(true);
  });
});

describe("scanRun — paging", () => {
  it("passes the cursor through so a caller can continue", async () => {
    const findCandidates = vi.fn(async () => ({
      candidates: [candidate()],
      cursor: "next-page",
      notes: ["a note"],
    }));

    const result = await scanRun(deps({ findCandidates }), {
      targeting: emptyTargeting(),
      limit: 10,
      cursor: "previous-page",
    });

    expect(findCandidates).toHaveBeenCalledWith(10, "previous-page");
    expect(result.cursor).toBe("next-page");
    expect(result.notes).toEqual(["a note"]);
  });

  it("threads the targeting into the sources it builds", async () => {
    const sources = vi.fn(() => []);
    const targeting = { ...emptyTargeting(), keywords: ["e-factura"], targetTitles: ["CMO"] };

    await scanRun(deps({ sources }), { targeting });

    expect(sources).toHaveBeenCalledWith(targeting);
  });
});
