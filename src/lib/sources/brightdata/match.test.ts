import { describe, expect, it } from "vitest";
import { companyMatches, companyTokens } from "./match";

/**
 * Every registry name here is real, taken from the mid-market lead set. The
 * LinkedIn side is how those companies plausibly write themselves.
 *
 * The asymmetry to keep in mind while reading: a false positive puts a
 * stranger's job title and profile URL on a lead and looks exactly like a
 * correct match. A false negative loses one title. These tests lean on the
 * refusals for that reason.
 */

describe("tokenising a Romanian legal name", () => {
  it("drops the legal form, which every company has", () => {
    expect(companyTokens("BUTAN GRUP SRL")).toEqual(["butan"]);
    expect(companyTokens("HIDRO PRAHOVA SA")).toEqual(["hidro", "prahova"]);
  });

  it("folds diacritics and punctuation", () => {
    expect(companyTokens("Țîră Construcţii S.R.L.")).toEqual(["tira", "constructii"]);
  });
});

describe("matching the same company across two spellings", () => {
  it("matches a name shortened on LinkedIn", () => {
    expect(companyMatches("BUTAN GRUP SRL", "Butan Grup").matched).toBe(true);
    expect(companyMatches("HIDRO PRAHOVA SA", "Hidro Prahova").matched).toBe(true);
    expect(companyMatches("NEXTUP MANAGEMENT SOLUTIONS S.R.L.", "NextUp").matched).toBe(true);
  });

  it("recovers an acronym written with dots", () => {
    // `A.E.G.-TECH SRL` on the register, `AEG Tech` on LinkedIn.
    expect(companyMatches("A.E.G.-TECH SRL", "AEG Tech").matched).toBe(true);
  });

  it("is not confused by diacritics on one side only", () => {
    expect(companyMatches("TERMOHABITAT S.R.L.", "Termohabitat").matched).toBe(true);
  });
});

describe("what it refuses, and why that matters more", () => {
  it("refuses two companies that share only generic words", () => {
    /*
     * The failure that would do real damage. These are unrelated companies, and
     * accepting them would attach a stranger to a lead with no visible sign
     * anything went wrong.
     */
    const verdict = companyMatches("ROMANIA TRADE INVEST SRL", "Romania Trading Services");
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toContain("generic");
  });

  it("refuses when the profile lists no employer at all", () => {
    expect(companyMatches("BUTAN GRUP SRL", undefined).matched).toBe(false);
    expect(companyMatches("BUTAN GRUP SRL", "   ").matched).toBe(false);
  });

  it("refuses an unrelated employer", () => {
    // The common case for a name-based search: right name, wrong person.
    expect(companyMatches("BUTAN GRUP SRL", "Banca Transilvania").matched).toBe(false);
  });

  it("refuses when the legal form is all the two share", () => {
    // Both are SRLs. That is true of nearly every Romanian company.
    expect(companyMatches("ALPHA SRL", "Beta SRL").matched).toBe(false);
  });

  it("refuses a name that reduces to nothing distinctive", () => {
    expect(companyMatches("SC SRL", "SA").matched).toBe(false);
  });
});
