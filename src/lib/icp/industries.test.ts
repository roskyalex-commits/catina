import { describe, expect, it } from "vitest";
import { INDUSTRY_DEFINITIONS } from "./industry-definitions";
import {
  INDUSTRIES,
  INDUSTRY_KEYS,
  NACE_CONFLICTS,
  industriesForCode,
  industryByKey,
  naceCodesFor,
  naceLabel,
  resolveIndustry,
} from "./industries";

/**
 * The industry table is generated from the official nomenclator, so what needs
 * testing is not the codes themselves but the properties the generator is
 * supposed to guarantee — and the one fact that makes the whole exercise
 * necessary: that CAEN has been renumbered underneath us and both numberings
 * are live in the same column.
 */

describe("the table itself", () => {
  it("is not empty, which the INDUSTRY_KEYS cast assumes", () => {
    expect(INDUSTRY_DEFINITIONS.length).toBeGreaterThan(0);
    expect(INDUSTRY_KEYS.length).toBe(INDUSTRY_DEFINITIONS.length);
  });

  it("has unique keys", () => {
    const keys = INDUSTRIES.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every industry at least one code", () => {
    // An industry with no codes is a targeting option that silently returns
    // nothing — worse than not offering it.
    const empty = INDUSTRIES.filter((i) => i.naceCodes.length === 0);
    expect(empty.map((i) => i.key)).toEqual([]);
  });

  it("assigns each code to exactly one industry", () => {
    // The generator resolves nesting by prefix length — `retail` takes the
    // whole of division 47 and `ecommerce` takes 4791 out of it. If that ever
    // stops holding, a code would be double-counted in two ICPs at once.
    const owners = new Map<string, string[]>();
    for (const industry of INDUSTRIES) {
      for (const code of industry.naceCodes) {
        owners.set(code, [...(owners.get(code) ?? []), industry.key]);
      }
    }
    const shared = [...owners.entries()].filter(([, keys]) => keys.length > 1);
    expect(shared).toEqual([]);
  });

  it("only ever produces well-formed four-digit codes", () => {
    for (const industry of INDUSTRIES) {
      for (const code of industry.naceCodes) {
        expect(code, `${industry.key} → ${code}`).toMatch(/^\d{4}$/);
      }
    }
  });

  it("labels every code it offers", () => {
    for (const industry of INDUSTRIES) {
      for (const code of industry.naceCodes) {
        expect(naceLabel(code), `${code} has no label`).toBeTruthy();
      }
    }
  });

  it("declares no alias twice across industries", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const industry of INDUSTRIES) {
      for (const alias of industry.aliases) {
        const owner = seen.get(alias);
        if (owner && owner !== industry.key) clashes.push(`${alias}: ${owner} vs ${industry.key}`);
        seen.set(alias, industry.key);
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe("both CAEN revisions", () => {
  it("covers custom software under the 2008 AND the 2025 numbering", () => {
    /*
     * This is the whole reason the table is generated rather than written out.
     * Custom software is 6201 under CAEN 2008 and 6210 under CAEN 2025;
     * `companies.caen` holds 2,263 rows of the first and 2,714 of the second.
     * An industry listing one and not the other halves its own reach silently.
     */
    const codes = naceCodesFor(["software"]);
    expect(codes).toContain("6201");
    expect(codes).toContain("6210");
  });

  it("covers IT consultancy across a revision that MERGED two classes", () => {
    // CAEN 2008 split consultancy (6202) from facilities management (6203);
    // CAEN 2025 merged both into 6220.
    const codes = naceCodesFor(["software"]);
    expect(codes).toEqual(expect.arrayContaining(["6202", "6203", "6220"]));
  });

  it("keeps e-commerce on the 2008 code only, because 2025 abolished it", () => {
    /*
     * NACE Rev. 2.1 stopped classifying sellers by *how* they sell. `4791`
     * meant "retail via mail order or the Internet" in CAEN 2008 and means
     * "intermediation in non-specialised retail" in CAEN 2025 — a different
     * activity. There is no 2025 code for an online shop, which is why the
     * technology on the site is the reliable signal instead.
     */
    expect(naceCodesFor(["ecommerce"])).toEqual(["4791"]);
    expect(naceCodesFor(["retail"])).not.toContain("4791");
  });
});

describe("resolveIndustry", () => {
  it("matches a key, a label, a Romanian label and an alias", () => {
    expect(resolveIndustry("software")).toBe("software");
    expect(resolveIndustry("Software & IT services")).toBe("software");
    expect(resolveIndustry("Transport și logistică")).toBe("logistics_transport");
    expect(resolveIndustry("magazin online")).toBe("ecommerce");
  });

  it("ignores diacritics in either direction", () => {
    expect(resolveIndustry("contabilitate")).toBe("accounting_legal");
    expect(resolveIndustry("Constructii")).toBe("construction");
    expect(resolveIndustry("Construcții")).toBe("construction");
  });

  it("finds an industry inside a longer phrase", () => {
    expect(resolveIndustry("small marketing agencies in Cluj")).toBe("marketing_agency");
  });

  it("does not match on a substring inside another word", () => {
    // The bug this prevents: "it" matching "retail", or "media" matching
    // "remedial" — the same class of error that made "IT" unusable as a
    // keyword until short keywords became case-sensitive.
    expect(resolveIndustry("remedial teaching")).not.toBe("media_publishing");
    expect(resolveIndustry("legitimate businesses")).not.toBe("software");
  });

  it("returns null rather than guessing", () => {
    expect(resolveIndustry("quantum basket weaving")).toBeNull();
    expect(resolveIndustry("x")).toBeNull();
  });

  it("prefers the longer phrase when two could match", () => {
    // "management consulting" must not lose to a bare "consulting".
    expect(resolveIndustry("management consulting")).toBe("management_consulting");
  });
});

describe("naceCodesFor and industriesForCode", () => {
  it("unions and deduplicates across industries", () => {
    const both = naceCodesFor(["software", "it_infrastructure"]);
    expect(new Set(both).size).toBe(both.length);
    expect(both).toEqual([...both].sort());
  });

  it("ignores a key that is not in the catalogue", () => {
    expect(naceCodesFor(["software", "teleportation"])).toEqual(naceCodesFor(["software"]));
  });

  it("maps a code back to its industry for display", () => {
    expect(industriesForCode("6210")).toEqual(["software"]);
    expect(industriesForCode("9999")).toEqual([]);
  });

  it("exposes conflicts rather than hiding them", () => {
    // Currently empty. It is asserted as an array rather than as empty so the
    // day a revision introduces a real collision, the generator's report is
    // what fails review — not this test.
    expect(Array.isArray(NACE_CONFLICTS)).toBe(true);
  });

  it("resolves a key to its definition", () => {
    expect(industryByKey("software")?.label).toBe("Software & IT services");
    expect(industryByKey("nope")).toBeUndefined();
  });
});
