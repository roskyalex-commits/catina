import { describe, expect, it } from "vitest";
import { scopedDedupeKey, signalFrom } from "./repository";

/**
 * The dedupe scoping is the whole reason this module exists.
 *
 * `signals_dedupe_idx` is UNIQUE on `dedupe_key` globally, and the news source
 * emits a key built only from the article guid. Two companies named in one
 * article would collide, and the second write would silently take the first
 * company's row. Nothing in production would surface it.
 */

describe("scopedDedupeKey", () => {
  it("keeps two companies apart when the source key is identical", () => {
    // Verbatim from sources/news.ts:76 — an article guid with no company in it.
    const raw = "news:funding:https://zf.ro/article-123";

    expect(scopedDedupeKey("company-a", raw)).not.toBe(
      scopedDedupeKey("company-b", raw),
    );
  });

  it("is stable across runs, so a rescan updates rather than duplicates", () => {
    const raw = "hiring:firma.ro:director-marketing";
    expect(scopedDedupeKey("company-a", raw)).toBe(scopedDedupeKey("company-a", raw));
  });

  it("keeps the source key readable in the stored value", () => {
    // A human debugging a signals row should be able to see which source wrote it.
    expect(scopedDedupeKey("abc", "tech_added:firma.ro:Shopify")).toContain(
      "tech_added:firma.ro:Shopify",
    );
  });
});

describe("signalFrom", () => {
  const row = {
    id: "s1",
    company_id: "c1",
    type: "hiring_buyer_role",
    title: "Hiring a Marketing Director",
    payload: { titles: ["Marketing Director"] },
    evidence_url: "https://firma.ro/cariere",
    strength: 0.8,
    detected_at: "2026-08-01T10:00:00Z",
    dedupe_key: "c1:hiring:firma.ro:x",
  };

  it("maps a well-formed row", () => {
    const signal = signalFrom(row)!;
    expect(signal.type).toBe("hiring_buyer_role");
    expect(signal.strength).toBe(0.8);
    expect(signal.detectedAt.toISOString()).toBe("2026-08-01T10:00:00.000Z");
    expect(signal.evidenceUrl).toBe("https://firma.ro/cariere");
  });

  it("drops a type this build does not know", () => {
    // An unknown type has no half-life, so it cannot be decayed. Defaulting the
    // decay would score it wrongly and silently; dropping it is honest.
    expect(signalFrom({ ...row, type: "some_future_signal" })).toBeNull();
  });

  it("drops a row with no detection date", () => {
    // Every score is a function of age. A signal with no date cannot be scored.
    expect(signalFrom({ ...row, detected_at: null })).toBeNull();
  });

  it("defaults a missing strength rather than scoring it as zero", () => {
    expect(signalFrom({ ...row, strength: null })?.strength).toBe(0.5);
  });

  it("falls back to the type when a row has no title", () => {
    expect(signalFrom({ ...row, title: null })?.title).toBe("hiring_buyer_role");
  });
});
