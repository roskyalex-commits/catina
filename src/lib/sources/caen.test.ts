import { describe, expect, it } from "vitest";
import {
  caenDivisions,
  caenLabel,
  caenSection,
  isValidCaen,
  parseCaenCodes,
} from "./caen";

describe("isValidCaen", () => {
  it("accepts exactly four digits", () => {
    expect(isValidCaen("6201")).toBe(true);
    expect(isValidCaen(" 4791 ")).toBe(true);
  });

  it("rejects anything else", () => {
    // A wrong code silently returns the wrong companies from the registry,
    // so this gate is the last thing between a typo and a bad lead list.
    expect(isValidCaen("62")).toBe(false);
    expect(isValidCaen("62010")).toBe(false);
    expect(isValidCaen("62O1")).toBe(false);
    expect(isValidCaen("")).toBe(false);
  });
});

describe("caenLabel", () => {
  it("returns the Romanian label for a curated code", () => {
    expect(caenLabel("6201")).toBe("Activități de realizare a soft-ului la comandă");
    expect(caenLabel("4791")).toContain("Internet");
  });

  it("falls back to the bare code rather than hiding an uncurated one", () => {
    // The curated table is a subset; an unusual but valid code must still work.
    expect(caenLabel("0161")).toBe("CAEN 0161");
  });
});

describe("caenSection", () => {
  it("maps a code to its NACE section", () => {
    expect(caenSection("6201")).toBe("Information and communication");
    expect(caenSection("4791")).toBe("Wholesale and retail trade");
    expect(caenSection("4120")).toBe("Construction");
    expect(caenSection("8623")).toBe("Human health and social work");
  });

  it("handles single-digit divisions with a leading zero", () => {
    expect(caenSection("0161")).toBe("Agriculture, forestry and fishing");
  });

  it("returns null for a malformed code", () => {
    expect(caenSection("62")).toBeNull();
    expect(caenSection("abcd")).toBeNull();
  });

  it("returns null for a division with no assigned section", () => {
    // Division 34 is unassigned in NACE Rev. 2 — don't invent a label.
    expect(caenSection("3400")).toBeNull();
  });
});

describe("caenDivisions", () => {
  it("widens codes to two-digit divisions and dedupes", () => {
    // Used when an exact-code registry query returns too few companies.
    expect(caenDivisions(["6201", "6202", "6209", "4791"])).toEqual(["62", "47"]);
  });

  it("skips invalid codes", () => {
    expect(caenDivisions(["6201", "nope", "62"])).toEqual(["62"]);
  });
});

describe("parseCaenCodes", () => {
  it("keeps valid codes and drops the rest", () => {
    expect(parseCaenCodes(["6201", " 4791 ", "software", "62"])).toEqual([
      "6201",
      "4791",
    ]);
  });

  it("dedupes", () => {
    expect(parseCaenCodes(["6201", "6201", " 6201"])).toEqual(["6201"]);
  });
});
