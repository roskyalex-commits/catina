import { describe, expect, it } from "vitest";
import {
  buildLocalPart,
  generateCandidates,
  inferDominantPattern,
  inferPatterns,
  isPlausibleEmail,
  isRoleAddress,
  slugifyName,
  splitFullName,
} from "./patterns";

/**
 * Pattern generation is the free backbone of the waterfall, and the only part
 * of Phase 3 that can be fully verified without network access. The Romanian
 * cases matter most: diacritics never appear in real addresses, so getting the
 * folding wrong produces addresses that bounce.
 */

describe("slugifyName", () => {
  it("folds Romanian diacritics to ASCII", () => {
    // Ștefănescu is written stefanescu in every real address.
    expect(slugifyName("Ștefănescu")).toBe("stefanescu");
    expect(slugifyName("Ionuț")).toBe("ionut");
    expect(slugifyName("Mihăiță")).toBe("mihaita");
    expect(slugifyName("Târgoviște")).toBe("targoviste");
  });

  it("handles both comma-below and cedilla spellings", () => {
    // Romanian text uses ș/ţ and ş/ț interchangeably depending on the font.
    expect(slugifyName("Ş")).toBe("s");
    expect(slugifyName("Ș")).toBe("s");
    expect(slugifyName("Ţ")).toBe("t");
    expect(slugifyName("Ț")).toBe("t");
  });

  it("strips punctuation, spaces and digits", () => {
    expect(slugifyName("O'Brien-Smith")).toBe("obriensmith");
    expect(slugifyName("Ana Maria")).toBe("anamaria");
    expect(slugifyName("John3")).toBe("john");
  });

  it("returns empty for undefined or unusable input", () => {
    expect(slugifyName(undefined)).toBe("");
    expect(slugifyName("...")).toBe("");
  });
});

describe("splitFullName", () => {
  it("takes first and last token, skipping middle names", () => {
    // Romanian records routinely carry a middle name or compound surname.
    expect(splitFullName("Ana Maria Popescu")).toEqual({
      firstName: "Ana",
      lastName: "Popescu",
    });
  });

  it("uses the final token as the surname in a compound name", () => {
    expect(splitFullName("Ana Maria Popescu Ionescu")).toEqual({
      firstName: "Ana",
      lastName: "Ionescu",
    });
  });

  it("handles a comma-inverted form", () => {
    expect(splitFullName("Popescu, Ana")).toEqual({
      firstName: "Popescu",
      lastName: "Ana",
    });
  });

  it("drops honorifics and suffixes", () => {
    // "Ing." and "Dr." are common prefixes on Romanian business cards.
    expect(splitFullName("Dr. Ana Popescu")).toEqual({
      firstName: "Ana",
      lastName: "Popescu",
    });
    expect(splitFullName("Ing. Mihai Ionescu")).toEqual({
      firstName: "Mihai",
      lastName: "Ionescu",
    });
    expect(splitFullName("John Smith Jr.")).toEqual({
      firstName: "John",
      lastName: "Smith",
    });
  });

  it("returns only a first name for a single token", () => {
    expect(splitFullName("Madonna")).toEqual({ firstName: "Madonna" });
  });

  it("returns empty for whitespace", () => {
    expect(splitFullName("   ")).toEqual({});
  });
});

describe("buildLocalPart", () => {
  const ana = { firstName: "Ana", lastName: "Popescu" };

  it("builds each supported convention", () => {
    expect(buildLocalPart("first.last", ana)).toBe("ana.popescu");
    expect(buildLocalPart("firstlast", ana)).toBe("anapopescu");
    expect(buildLocalPart("flast", ana)).toBe("apopescu");
    expect(buildLocalPart("f.last", ana)).toBe("a.popescu");
    expect(buildLocalPart("firstl", ana)).toBe("anap");
    expect(buildLocalPart("last.first", ana)).toBe("popescu.ana");
    expect(buildLocalPart("lastf", ana)).toBe("popescua");
    expect(buildLocalPart("first_last", ana)).toBe("ana_popescu");
    expect(buildLocalPart("first-last", ana)).toBe("ana-popescu");
  });

  it("returns null when a required part is missing", () => {
    // Better no candidate than "undefined@domain.ro".
    expect(buildLocalPart("first.last", { firstName: "Ana" })).toBeNull();
    expect(buildLocalPart("flast", { lastName: "Popescu" })).toBeNull();
  });

  it("still builds single-part patterns from one name", () => {
    expect(buildLocalPart("first", { firstName: "Ana" })).toBe("ana");
    expect(buildLocalPart("last", { lastName: "Popescu" })).toBe("popescu");
  });

  it("applies diacritic folding", () => {
    expect(
      buildLocalPart("first.last", { firstName: "Ionuț", lastName: "Ștefănescu" }),
    ).toBe("ionut.stefanescu");
  });
});

describe("inferPatterns", () => {
  const ana = { firstName: "Ana", lastName: "Popescu" };

  it("identifies the convention from a known address", () => {
    expect(inferPatterns("ana.popescu@x.ro", ana)).toContain("first.last");
    expect(inferPatterns("apopescu@x.ro", ana)).toContain("flast");
  });

  it("matches through diacritics on the person's name", () => {
    // The address is ASCII; the name record is not.
    expect(
      inferPatterns("ionut.stefanescu@x.ro", {
        firstName: "Ionuț",
        lastName: "Ștefănescu",
      }),
    ).toContain("first.last");
  });

  it("returns every consistent pattern when the sample is ambiguous", () => {
    const matches = inferPatterns("ana@x.ro", { firstName: "Ana", lastName: "Ana" });
    expect(matches).toContain("first");
    expect(matches).toContain("last");
  });

  it("returns nothing when the address matches no convention", () => {
    expect(inferPatterns("office@x.ro", ana)).toEqual([]);
  });
});

describe("inferDominantPattern", () => {
  it("picks the convention shared across samples", () => {
    const result = inferDominantPattern([
      { email: "ana.popescu@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
      { email: "mihai.ionescu@x.ro", name: { firstName: "Mihai", lastName: "Ionescu" } },
      { email: "elena.radu@x.ro", name: { firstName: "Elena", lastName: "Radu" } },
    ]);

    expect(result?.pattern).toBe("first.last");
    expect(result?.confidence).toBeGreaterThan(0.8);
  });

  it("is less confident from a single sample than from three", () => {
    // One person may have a legacy address; three rarely share an exception.
    const one = inferDominantPattern([
      { email: "ana.popescu@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
    ]);
    const three = inferDominantPattern([
      { email: "ana.popescu@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
      { email: "mihai.ionescu@x.ro", name: { firstName: "Mihai", lastName: "Ionescu" } },
      { email: "elena.radu@x.ro", name: { firstName: "Elena", lastName: "Radu" } },
    ]);

    expect(one!.confidence).toBeLessThan(three!.confidence);
  });

  it("survives one outlier among several agreeing samples", () => {
    const result = inferDominantPattern([
      { email: "ana.popescu@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
      { email: "mihai.ionescu@x.ro", name: { firstName: "Mihai", lastName: "Ionescu" } },
      { email: "eradu@x.ro", name: { firstName: "Elena", lastName: "Radu" } },
    ]);
    expect(result?.pattern).toBe("first.last");
  });

  it("ignores samples that match nothing, rather than letting them dilute confidence", () => {
    const result = inferDominantPattern([
      { email: "ana.popescu@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
      { email: "office@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
    ]);
    expect(result?.pattern).toBe("first.last");
  });

  it("returns null when nothing can be inferred", () => {
    expect(
      inferDominantPattern([
        { email: "office@x.ro", name: { firstName: "Ana", lastName: "Popescu" } },
      ]),
    ).toBeNull();
  });

  it("returns null for no samples", () => {
    expect(inferDominantPattern([])).toBeNull();
  });
});

describe("generateCandidates", () => {
  it("puts the known pattern first at high confidence", () => {
    const candidates = generateCandidates("Ana Popescu", "smartbill.ro", {
      knownPattern: "flast",
      patternConfidence: 0.9,
    });

    expect(candidates[0]).toMatchObject({
      address: "apopescu@smartbill.ro",
      pattern: "flast",
      confidence: 0.9,
    });
  });

  it("keeps unverified guesses at low confidence", () => {
    // These must never be mistaken for verified addresses at send time.
    const candidates = generateCandidates("Ana Popescu", "smartbill.ro");
    expect(candidates[0].address).toBe("ana.popescu@smartbill.ro");
    for (const candidate of candidates) {
      expect(candidate.confidence).toBeLessThan(0.4);
    }
  });

  it("strips www and normalises the domain", () => {
    const [first] = generateCandidates("Ana Popescu", "WWW.SmartBill.RO");
    expect(first.address).toBe("ana.popescu@smartbill.ro");
  });

  it("respects the max and produces no duplicates", () => {
    const candidates = generateCandidates("Ana Popescu", "x.ro", { max: 3 });
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((c) => c.address)).size).toBe(3);
  });

  it("still generates from a single-token name", () => {
    const candidates = generateCandidates("Madonna", "x.ro");
    expect(candidates.map((c) => c.address)).toEqual(["madonna@x.ro"]);
  });

  it("returns nothing for an unusable name or domain", () => {
    expect(generateCandidates("", "x.ro")).toEqual([]);
    expect(generateCandidates("Ana Popescu", "localhost")).toEqual([]);
  });

  it("folds diacritics into the generated address", () => {
    const [first] = generateCandidates("Ionuț Ștefănescu", "firma.ro");
    expect(first.address).toBe("ionut.stefanescu@firma.ro");
  });
});

describe("isRoleAddress", () => {
  it("recognises English and Romanian role prefixes", () => {
    // These are the addresses that stay usable for Romanian outreach.
    expect(isRoleAddress("office@x.ro")).toBe(true);
    expect(isRoleAddress("vanzari@x.ro")).toBe(true);
    expect(isRoleAddress("facturare@x.ro")).toBe(true);
    expect(isRoleAddress("contact@x.ro")).toBe(true);
  });

  it("does not flag a personal address", () => {
    expect(isRoleAddress("ana.popescu@x.ro")).toBe(false);
  });

  it("ignores plus-addressing when matching", () => {
    expect(isRoleAddress("office+leads@x.ro")).toBe(true);
  });
});

describe("isPlausibleEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isPlausibleEmail("ana.popescu@smart-bill.ro")).toBe(true);
    expect(isPlausibleEmail("a+b@sub.domain.co.uk")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isPlausibleEmail("ana.popescu")).toBe(false);
    expect(isPlausibleEmail("ana@localhost")).toBe(false);
    expect(isPlausibleEmail("ana popescu@x.ro")).toBe(false);
    expect(isPlausibleEmail("@x.ro")).toBe(false);
  });
});
