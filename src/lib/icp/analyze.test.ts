import { describe, expect, it } from "vitest";
import { normalise } from "./analyze";

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
  caenCodes: ["6920", "4791"],
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
    expect(icp.caenCodes).toEqual(["6920", "4791"]);
    expect(icp.employeeMin).toBe(5);
    expect(icp.employeeMax).toBe(250);
    expect(icp.countries).toEqual(["RO"]);
  });

  it("drops malformed CAEN codes instead of failing the whole parse", () => {
    // A dropped code costs the user one checkbox in onboarding step 2;
    // a thrown error costs them the entire analysis.
    const icp = normalise({
      ...base,
      caenCodes: ["6920", "62", "software", "47910", " 4791 ", ""],
    });
    expect(icp.caenCodes).toEqual(["6920", "4791"]);
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
