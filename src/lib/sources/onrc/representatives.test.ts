import { describe, expect, it } from "vitest";
import {
  isDecisionMakerRole,
  isNaturalPerson,
  normaliseRole,
  tidyName,
} from "./representatives";

/**
 * Roles and names taken from the real OD_REPREZENTANTI_LEGALI export, where
 * insolvency practitioners outnumber administrators and a large minority of
 * "representatives" are companies rather than people.
 */

describe("normaliseRole", () => {
  it("folds diacritics and punctuation", () => {
    expect(normaliseRole("Administrator")).toBe("administrator");
    expect(normaliseRole("membru în consiliul de supraveghere")).toBe(
      "membru in consiliul de supraveghere",
    );
  });
});

describe("isDecisionMakerRole", () => {
  it.each([
    "administrator",
    "Administrator",
    "administrator si reprezentant",
    "reprezentant legal",
    "director general unic",
  ])("accepts %s", (role) => {
    expect(isDecisionMakerRole(role)).toBe(true);
  });

  it.each([
    "lichidator",
    "lichidator judiciar",
    "lichidator provizoriu",
    "lichidator judiciar provizoriu",
    "administrator judiciar",
    "administrator judiciar provizoriu",
    "administrator special",
    "administrator concordatar",
  ])("rejects the court-appointed role %s", (role) => {
    // These outnumber real administrators in the file, and a company that has
    // one is being wound up rather than buying software.
    expect(isDecisionMakerRole(role)).toBe(false);
  });

  it("rejects an empty role", () => {
    expect(isDecisionMakerRole("")).toBe(false);
    expect(isDecisionMakerRole("   ")).toBe(false);
  });

  it("keeps an unlisted administrator variant", () => {
    // `startsWith("administrator")` is the catch-all, but only after the
    // insolvency markers have had their say.
    expect(isDecisionMakerRole("administrator unic")).toBe(true);
  });
});

describe("isNaturalPerson", () => {
  it.each([
    ["REINVENT STRATEGIC BUSINESS SOLUTIONS  SRL", false],
    ["SC KPMG ROMANIA SRL", false],
    ["CORMAG BUSINESS SERVICES INC.", false],
    ["FOCUS INSOLV IPURL", false],
    ["ANTARES 2000 COMIMPEX SRL", false],
  ])("treats %s as a company", (name, expected) => {
    // "Dear KPMG Romania SRL," is worse than one missing contact.
    expect(isNaturalPerson(name, false)).toBe(expected);
  });

  it("accepts a person with birth data", () => {
    expect(isNaturalPerson("POPESCU ION", true)).toBe(true);
    expect(isNaturalPerson("SAVA CATRINEL-IONELA", true)).toBe(true);
  });

  it("accepts a plain two-part name without birth data", () => {
    expect(isNaturalPerson("POPESCU ION", false)).toBe(true);
  });

  it("rejects a practice title even though it looks name-like", () => {
    expect(isNaturalPerson("C.I.I.SAVA CATRINEL-IONELA", false)).toBe(false);
  });

  it("rejects a single token", () => {
    expect(isNaturalPerson("POPESCU", true)).toBe(false);
  });

  it("rejects something too short to be a name", () => {
    expect(isNaturalPerson("X", true)).toBe(false);
    expect(isNaturalPerson("", true)).toBe(false);
  });
});

describe("tidyName", () => {
  it("converts the register's upper case to title case", () => {
    expect(tidyName("POPESCU ION")).toBe("Popescu Ion");
  });

  it("capitalises both halves of a hyphenated given name", () => {
    // Common in Romanian and easy to get wrong.
    expect(tidyName("SAVA CATRINEL-IONELA")).toBe("Sava Catrinel-Ionela");
  });

  it("collapses the register's irregular spacing", () => {
    expect(tidyName("  MARIN   ELENA  ")).toBe("Marin Elena");
  });

  it("keeps Romanian diacritics", () => {
    expect(tidyName("ȘTEFĂNESCU ANDREEA")).toBe("Ștefănescu Andreea");
  });
});
