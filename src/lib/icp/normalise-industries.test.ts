import { describe, expect, it } from "vitest";
import { naceCodesFor } from "./industries";
import { normaliseIcpIndustries } from "./normalise-industries";
import { icpSchema, type Icp } from "./schema";

/**
 * This is the single point where a human-readable industry becomes the codes a
 * SQL query filters on, so the properties worth pinning are the ones that make
 * a stored agent and a live query agree — and the one that stops a working
 * agent's targeting changing under it.
 */

function icp(overrides: Partial<Icp> = {}): Icp {
  return icpSchema.parse({
    valueProp: "Invoicing software for Romanian SMBs.",
    targetTitles: ["Director General"],
    ...overrides,
  });
}

describe("deriving codes", () => {
  it("turns free-text industries into keys and keys into codes", () => {
    const { icp: result, unresolved } = normaliseIcpIndustries(
      icp({ industries: ["Software", "Transport"] }),
    );

    expect(result.industryKeys).toEqual(["software", "logistics_transport"]);
    expect(result.caenCodes).toEqual(naceCodesFor(["software", "logistics_transport"]));
    expect(unresolved).toEqual([]);
  });

  it("keeps an industry it could not resolve, and reports it", () => {
    const { icp: result, unresolved } = normaliseIcpIndustries(
      icp({ industries: ["Software", "Quantum basket weaving"] }),
    );

    // Nothing the user wrote is discarded — the wizard can show it as unmatched
    // rather than have it vanish between screens.
    expect(result.industries).toContain("Quantum basket weaving");
    expect(unresolved).toEqual(["Quantum basket weaving"]);
    expect(result.industryKeys).toEqual(["software"]);
  });

  it("treats keys already chosen as authoritative", () => {
    const { icp: result } = normaliseIcpIndustries(
      icp({ industryKeys: ["healthcare"], industries: ["Software"] }),
    );
    // The picker's choice comes first, then anything the free text adds.
    expect(result.industryKeys).toEqual(["healthcare", "software"]);
  });

  it("does not duplicate a key reachable both ways", () => {
    const { icp: result } = normaliseIcpIndustries(
      icp({ industryKeys: ["software"], industries: ["Software", "SaaS"] }),
    );
    expect(result.industryKeys).toEqual(["software"]);
  });

  it("drops a stored key that is no longer in the catalogue", () => {
    // Rows outlive catalogues. A key removed in a later release must not end up
    // in a query as an unmatched string.
    const { icp: result } = normaliseIcpIndustries(icp({ industryKeys: ["retired_industry"] }));
    expect(result.industryKeys).toEqual([]);
  });

  it("re-adds a key whose free text is still present — the caller must clear both", () => {
    /*
     * Caught in a browser, not by a test: deselecting an industry in the picker
     * did nothing at all. The key came off, `industries` still said
     * "E-commerce", the very next normalise resolved it back, and the checkbox
     * sprang on again.
     *
     * The behaviour pinned here is deliberate — free text resolving to a key is
     * the whole mechanism — so the fix belongs in the callers, which now drop
     * the matching phrase when they drop the key. This test exists so nobody
     * "fixes" it here and breaks resolution instead.
     */
    const { icp: result } = normaliseIcpIndustries(
      icp({ industryKeys: [], industries: ["E-commerce"] }),
    );
    expect(result.industryKeys).toEqual(["ecommerce"]);

    const { icp: cleared } = normaliseIcpIndustries(
      icp({ industryKeys: [], industries: [] }),
    );
    expect(cleared.industryKeys).toEqual([]);
  });

  it("is idempotent", () => {
    const once = normaliseIcpIndustries(icp({ industries: ["Software"] })).icp;
    const twice = normaliseIcpIndustries(once).icp;
    expect(twice).toEqual(once);
  });
});

describe("caenCodesOverridden", () => {
  it("leaves a hand-edited code list completely alone", () => {
    const { icp: result } = normaliseIcpIndustries(
      icp({
        industries: ["Software"],
        caenCodes: ["6210"],
        caenCodesOverridden: true,
      }),
    );

    // Without this, the next save would silently re-widen a list somebody
    // deliberately narrowed — and they would only find out from the results.
    expect(result.caenCodes).toEqual(["6210"]);
  });

  it("still resolves the industry keys while pinning the codes", () => {
    const { icp: result } = normaliseIcpIndustries(
      icp({ industries: ["Software"], caenCodes: ["6210"], caenCodesOverridden: true }),
    );
    // The keys are what the UI displays; only the derivation is suppressed.
    expect(result.industryKeys).toEqual(["software"]);
  });
});

describe("the ceiling", () => {
  it("reports truncation rather than quietly cutting the query short", () => {
    // Eight broad industries overflow 60 codes easily. A user who picks them
    // gets a narrowed query and, without this flag, no indication of it.
    const broad = [
      "wholesale",
      "retail",
      "agriculture",
      "metal_products",
      "food_beverage",
      "construction",
      "textiles_apparel",
      "arts_entertainment",
    ];
    const { icp: result, truncated } = normaliseIcpIndustries(icp({ industryKeys: broad }));

    expect(truncated).toBe(true);
    expect(result.caenCodes).toHaveLength(60);
    expect(icpSchema.safeParse(result).success).toBe(true);
  });

  it("does not claim truncation when everything fits", () => {
    const { truncated } = normaliseIcpIndustries(icp({ industryKeys: ["software"] }));
    expect(truncated).toBe(false);
  });
});
