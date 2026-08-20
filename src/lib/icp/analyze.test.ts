import { describe, expect, it } from "vitest";
import { normalise } from "./analyze";
import { naceCodesFor } from "./industries";

/**
 * `normalise` is the seam between what the model returns and what the app
 * relies on. The interesting cases are all model slips: a plausible-looking
 * value that would either poison a downstream query (a bad CAEN code sent to
 * ANAF) or throw and lose the whole analysis.
 */

const base = {
  valueProp: "Software de facturare pentru IMM-uri din România.",
  productName: "FacturaPro",
  targetTitles: ["Director General", "Contabil Sef"],
  targetSeniorities: ["c_level" as const],
  industries: ["Accounting", "Retail"],
  industryKeys: ["accounting_legal", "retail"],
  companyTypes: ["smb" as const],
  countries: ["RO"],
  keywords: ["facturare", "e-factura"],
  competitors: ["SmartBill", "Oblio"],
  exclusions: ["Enterprise ERP vendors"],
  employeeMin: 5,
  employeeMax: 250,
  confidence: 0.8,
  assumptions: [],
};

describe("normalise", () => {
  it("passes a well-formed extraction through intact", () => {
    const icp = normalise(base);
    // The base fixture picks accounting_legal and retail, and its free-text
    // "Accounting"/"Retail" resolve to the same two, so the codes are the union
    // of exactly those industries and nothing the model made up.
    expect(icp.industryKeys).toEqual(["accounting_legal", "retail"]);
    expect(icp.caenCodes).toEqual(naceCodesFor(["accounting_legal", "retail"]));
    expect(icp.employeeMin).toBe(5);
    expect(icp.employeeMax).toBe(250);
    expect(icp.countries).toEqual(["RO"]);
  });

  it("derives CAEN codes from the chosen industries rather than asking for them", () => {
    // The model no longer returns codes at all — that was the last unchecked
    // model→SQL path in the product. Every code here comes from the official
    // nomenclator via the industry the model picked.
    const icp = normalise({ ...base, industryKeys: ["software"] });

    expect(icp.industryKeys).toContain("software");
    // Both CAEN revisions, which is the thing a hand-written list gets wrong:
    // 6201 is custom software under CAEN 2008 and 6210 under CAEN 2025, and
    // `companies.caen` holds thousands of rows of each.
    expect(icp.caenCodes).toContain("6201");
    expect(icp.caenCodes).toContain("6210");
    expect(icp.caenCodes.every((code) => /^\d{4}$/.test(code))).toBe(true);
  });

  it("ignores an industry key that is not in the catalogue", () => {
    // z.enum makes this unreachable from the model, but `normalise` is also the
    // seam a stored row passes back through, and rows outlive catalogues.
    const icp = normalise({ ...base, industryKeys: ["software", "teleportation"] });
    expect(icp.industryKeys).toContain("software");
    expect(icp.industryKeys).not.toContain("teleportation");
  });

  it("treats 0 headcount as unknown rather than a literal bound", () => {
    const icp = normalise({ ...base, employeeMin: 0, employeeMax: 0 });
    expect(icp.employeeMin).toBeNull();
    expect(icp.employeeMax).toBeNull();
  });

  it("drops a reversed headcount range", () => {
    const icp = normalise({ ...base, employeeMin: 500, employeeMax: 10 });
    expect(icp.employeeMin).toBe(500);
    expect(icp.employeeMax).toBeNull();
  });

  it("upper-cases country codes and drops non-alpha-2 entries", () => {
    const icp = normalise({
      ...base,
      countries: ["ro", "de", "Romania", "USA", "gb"],
    });
    expect(icp.countries).toEqual(["RO", "DE", "GB"]);
  });

  it("falls back to RO when no usable country survives", () => {
    const icp = normalise({ ...base, countries: ["Romania", "Europe"] });
    expect(icp.countries).toEqual(["RO"]);
  });

  it("dedupes case-insensitively but keeps the first spelling", () => {
    const icp = normalise({
      ...base,
      targetTitles: ["CEO", "ceo", "  CEO  ", "CFO"],
    });
    expect(icp.targetTitles).toEqual(["CEO", "CFO"]);
  });

  it("clamps confidence into 0..1", () => {
    expect(normalise({ ...base, confidence: 1.7 }).confidence).toBe(1);
    expect(normalise({ ...base, confidence: -0.2 }).confidence).toBe(0);
  });

  it("always yields at least one target title", () => {
    const icp = normalise({ ...base, targetTitles: ["", "   "] });
    expect(icp.targetTitles).toEqual(["Founder"]);
  });

  it("treats an empty productName as absent", () => {
    expect(normalise({ ...base, productName: "" }).productName).toBeUndefined();
  });
});

describe("normalise — competitors", () => {
  it("routes a competitor we can fingerprint into competitorTech", () => {
    const icp = normalise({ ...base, competitors: ["HubSpot"] });
    expect(icp.competitorTech).toEqual(["HubSpot"]);
    expect(icp.competitorNames).toEqual([]);
  });

  it("stores it under our own display name whatever casing the model used", () => {
    // `TECH_MARKERS` is keyed on display strings, so a lower-cased entry would
    // sit in the column and never match anything the crawler detects.
    expect(normalise({ ...base, competitors: ["hubspot"] }).competitorTech).toEqual([
      "HubSpot",
    ]);
  });

  it("degrades an undetectable competitor to a text match rather than dropping it", () => {
    // Promising to spot a competitor and then silently not spotting it is worse
    // than saying the detection is weaker.
    const icp = normalise({ ...base, competitors: ["Oblio", "Shopify"] });
    expect(icp.competitorTech).toEqual(["Shopify"]);
    expect(icp.competitorNames).toEqual(["Oblio"]);
  });

  it("survives a model that returns no competitors at all", () => {
    const icp = normalise({ ...base, competitors: [] });
    expect(icp.competitorTech).toEqual([]);
    expect(icp.competitorNames).toEqual([]);
  });
});
