import { describe, expect, it } from "vitest";
import { RegistryIndex, cuisStatedOn, normalisePhone } from "./match";

/**
 * A Google Maps listing has no CUI, so it has to be matched back to a company
 * we already hold. The asymmetry that shapes every rule here: a false positive
 * attaches a stranger's website and phone number to a lead and looks exactly
 * like a correct match, while a false negative loses one domain.
 *
 * So these lean on the refusals.
 */

const COMPANIES = [
  { id: "a", name: "RED BEE SOFTWARE S.R.L.", county: "Cluj", phone: "0264595091" },
  { id: "b", name: "CERT PLUS S.R.L.", county: "Cluj", phone: "021.351.35.30" },
  { id: "c", name: "BUTAN GRUP SRL", county: "Prahova", phone: "0744123456" },
  // Two companies at an accountant's switchboard — the 4.8% ambiguous case.
  { id: "d", name: "ALPHA CONSULTING SRL", county: "București", phone: "0213334444" },
  { id: "e", name: "BETA LOGISTIC SRL", county: "București", phone: "0213334444" },
];

const index = new RegistryIndex(COMPANIES);

describe("normalisePhone", () => {
  it("reduces the ways both sources write the same line", () => {
    // ANAF files it one way, Google another. Same phone.
    expect(normalisePhone("0264595091")).toBe("0264595091");
    expect(normalisePhone("021.351.35.30")).toBe("0213513530");
    expect(normalisePhone("+40 264 595 091")).toBe("0264595091");
    expect(normalisePhone("0040264595091")).toBe("0264595091");
    expect(normalisePhone("(0264) 59 50 91")).toBe("0264595091");
  });

  it("takes the first of two numbers rather than welding them", () => {
    expect(normalisePhone("0264595091 / 0264595092")).toBe("0264595091");
  });

  it("refuses anything that is not a ten-digit Romanian number", () => {
    /*
     * `07411622014` is in the register with an extra digit. Matching on a typo
     * is worse than not matching: it would join two unrelated companies with
     * nothing to show that it had.
     */
    expect(normalisePhone("07411622014")).toBeUndefined();
    expect(normalisePhone("123")).toBeUndefined();
    expect(normalisePhone("")).toBeUndefined();
    expect(normalisePhone(null)).toBeUndefined();
    expect(normalisePhone("N/A")).toBeUndefined();
  });
});

describe("matching a listing to a company", () => {
  it("matches on a phone number that belongs to one company", () => {
    const verdict = index.match({ name: "Red Bee", phone: "+40 264 595 091" });
    expect(verdict.matched).toBe(true);
    if (verdict.matched) {
      expect(verdict.companyId).toBe("a");
      expect(verdict.by).toBe("phone");
    }
  });

  it("matches on name within the county when there is no phone", () => {
    const verdict = index.match({ name: "Butan Grup", county: "Prahova" });
    expect(verdict.matched).toBe(true);
    if (verdict.matched) expect(verdict.by).toBe("name");
  });

  it("folds diacritics on the county before comparing", () => {
    const verdict = index.match({ name: "Butan Grup", county: "PRAHOVA" });
    expect(verdict.matched).toBe(true);
  });
});

describe("what it refuses", () => {
  it("refuses a shared switchboard the name cannot settle", () => {
    /*
     * 539 numbers in the register are used by more than one company, one of them
     * by 26. Taking the first would attach the listing to whichever row sorted
     * first, with nothing visible to say it had guessed.
     */
    const verdict = index.match({ name: "Gamma Altceva SRL", phone: "0213334444" });
    expect(verdict.matched).toBe(false);
    if (!verdict.matched) expect(verdict.reason).toContain("shared");
  });

  it("settles a shared number when the name identifies one of them", () => {
    const verdict = index.match({ name: "Alpha Consulting", phone: "0213334444" });
    expect(verdict.matched).toBe(true);
    if (verdict.matched) expect(verdict.companyId).toBe("d");
  });

  it("refuses a name that only shares generic words", () => {
    // `companyMatches` already refuses these; this pins that the maps join
    // inherits the refusal rather than reimplementing a looser rule.
    const loose = new RegistryIndex([
      { id: "x", name: "ROMANIA TRADE INVEST SRL", county: "Cluj", phone: null },
    ]);
    const verdict = loose.match({ name: "Romania Trading Services", county: "Cluj" });
    expect(verdict.matched).toBe(false);
  });

  it("refuses a company in a different county with a similar name", () => {
    // Same name, wrong place. The county is part of the identity.
    const verdict = index.match({ name: "Butan Grup", county: "Cluj" });
    expect(verdict.matched).toBe(false);
  });

  it("refuses a listing with neither a usable phone nor a name", () => {
    expect(index.match({ phone: "123" }).matched).toBe(false);
    expect(index.match({ name: "   ", county: "Cluj" }).matched).toBe(false);
  });
});

describe("the index reports its own join quality", () => {
  it("counts how many numbers point at exactly one company", () => {
    // On the live database this is 10,763 of 11,302 — 95.2%. Here, three of the
    // four numbers are unique and one is shared.
    expect(index.phoneStats()).toEqual({ distinct: 4, unique: 3 });
  });
});

describe("cuisStatedOn", () => {
  it("reads the CUI a Romanian site prints about itself", () => {
    expect([...cuisStatedOn("<footer>CUI: RO12345678</footer>")]).toEqual(["12345678"]);
    expect([...cuisStatedOn("<p>C.I.F. 12345678</p>")]).toEqual(["12345678"]);
    expect([...cuisStatedOn("Cod unic de înregistrare 12345678")]).toEqual(["12345678"]);
  });

  it("strips leading zeros so both sides compare equal", () => {
    expect([...cuisStatedOn("CUI: 0012345678")]).toEqual(["12345678"]);
  });

  it("finds nothing on a page that states none", () => {
    // Roughly seven sites in eight. This is a confirmation tier, not a lookup.
    expect(cuisStatedOn("<p>Bine ați venit pe site-ul nostru.</p>").size).toBe(0);
  });

  it("does not mistake a phone number or a postcode for a CUI", () => {
    expect(cuisStatedOn("Telefon: 0264595091").size).toBe(0);
    expect(cuisStatedOn("Cod poștal 400001").size).toBe(0);
  });
});
