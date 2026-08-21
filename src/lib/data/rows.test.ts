import { describe, expect, it } from "vitest";
import type { Signal } from "@/lib/signals/types";
import { contactRowFrom, telHref } from "./rows";

/**
 * The SIGNAL column is the product's whole claim in one cell, and it spent
 * several releases showing the CAEN code the lead was *found* by. These pin the
 * order it resolves in, because the failure was silent: the column rendered
 * something plausible and nobody noticed it was the wrong fact.
 */

function leadRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "lead-1",
    company_id: "company-1",
    score: 76,
    source_label: "keyword",
    source_query: "CAEN 6201",
    created_at: new Date().toISOString(),
    people: { full_name: "Marușca Vlad", title: "administrator" },
    companies: { name: "REDBEE SOFTWARE S.R.L.", domain: "redbeesoftware.com", country: "RO" },
    ...overrides,
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "competitor_tech",
    title: "Runs WooCommerce today",
    evidenceUrl: "https://redbeesoftware.com",
    strength: 0.85,
    detectedAt: new Date(),
    dedupeKey: "k",
    ...overrides,
  };
}

describe("the SIGNAL column", () => {
  it("shows a buying signal when the company has one", () => {
    const row = contactRowFrom(leadRow(), [signal()]);

    expect(row.signal?.title).toBe("Runs WooCommerce today");
    expect(row.signal?.kind).toBe("signal");
    // The evidence link is the differentiator; without it this is just a claim.
    expect(row.signal?.evidenceUrl).toBe("https://redbeesoftware.com");
  });

  it("falls back to how the lead was sourced when there is no signal", () => {
    // 855 of 919 leads are in this state. "Matched CAEN 6201" is a poor signal
    // but an honest answer to "why is this person on my list".
    const row = contactRowFrom(leadRow(), []);
    expect(row.signal?.title).toBe("Matched CAEN 6201");
    expect(row.signal?.kind).toBe("keyword");
  });

  it("prefers the strongest signal, decayed", () => {
    const old = signal({
      type: "funding_news",
      title: "Raised a seed round",
      strength: 0.9,
      // Funding decays with a 60-day half-life, so nine months is nearly gone.
      detectedAt: new Date(Date.now() - 270 * 86_400_000),
    });
    const fresh = signal({ title: "Runs HubSpot today", strength: 0.85 });

    expect(contactRowFrom(leadRow(), [old, fresh]).signal?.title).toBe(
      "Runs HubSpot today",
    );
  });

  it("compares on decayed strength, not raw strength", () => {
    // Raw, the funding round wins 0.9 to 0.85. It must not.
    const raw = [
      signal({ type: "funding_news", title: "Old news", strength: 0.9, detectedAt: new Date(Date.now() - 270 * 86_400_000) }),
      signal({ title: "Fresh detection", strength: 0.85 }),
    ];
    expect(contactRowFrom(leadRow(), raw).signal?.title).toBe("Fresh detection");
  });

  it("never headlines a distress signal", () => {
    /*
     * Insolvency is real and belongs in the breakdown, but a row whose headline
     * reads "Insolvency proceedings on record" is not a lead the user is being
     * invited to act on — and it would outrank a genuine buying signal on
     * strength alone.
     */
    const row = contactRowFrom(leadRow(), [
      signal({ type: "insolvency_risk", title: "Insolvency proceedings on record", strength: 1 }),
      signal({ title: "Runs WooCommerce today", strength: 0.5 }),
    ]);
    expect(row.signal?.title).toBe("Runs WooCommerce today");
  });

  it("falls back to provenance when the only signals are distress", () => {
    const row = contactRowFrom(leadRow(), [
      signal({ type: "insolvency_risk", title: "Insolvency proceedings on record", strength: 1 }),
    ]);
    expect(row.signal?.title).toBe("Matched CAEN 6201");
  });

  it("says something even for a lead with no signal and no query", () => {
    const row = contactRowFrom(
      leadRow({ source_label: "autopilot", source_query: null }),
      [],
    );
    expect(row.signal?.title).toBe("Matched your targeting");
  });
});

/**
 * Every input below is a real value from the `companies` table. The register
 * takes the number as filed, so "however the company wrote it" is the format.
 */
describe("telHref", () => {
  it("dials a plain number", () => {
    expect(telHref("0264595091")).toBe("tel:0264595091");
  });

  it("strips the separators a company typed", () => {
    expect(telHref("021.351.35.30")).toBe("tel:0213513530");
    expect(telHref("+40 264 000 000")).toBe("tel:+40264000000");
    expect(telHref("(0264) 59-50-91")).toBe("tel:0264595091");
  });

  it("takes the first of two numbers rather than welding them together", () => {
    // Joining these produces a third number that belongs to someone else.
    expect(telHref("0264595091 / 0264595092")).toBe("tel:0264595091");
    expect(telHref("0264595091, 0722111222")).toBe("tel:0264595091");
  });

  it("links a number with an extra digit rather than hiding it", () => {
    // `07411622014` is in the data. The dialler will fail; the user can read it.
    expect(telHref("07411622014")).toBe("tel:07411622014");
  });

  it("has nothing to dial for an empty or junk value", () => {
    // ANAF stores "" for 4,753 companies — not null, and not a phone number.
    expect(telHref("")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref("-")).toBeNull();
    expect(telHref("N/A")).toBeNull();
  });
});
