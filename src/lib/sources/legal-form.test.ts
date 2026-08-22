import { describe, expect, it } from "vitest";
import { canonicalLegalForm } from "./legal-form";

/**
 * Every input below is a real value that was found in `companies.legal_form`
 * after ONRC and ANAF had both written to it. The counts are from that census:
 * 260,815 rows said `SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ` and 31,453
 * said `SRL`, for the same legal form, and the filter built against the second
 * spelling silently stopped matching the first.
 */

describe("ANAF's long names become ONRC's codes", () => {
  it("maps the one that matters — 260,815 rows of it", () => {
    expect(canonicalLegalForm("SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ")).toBe("SRL");
  });

  it("maps the rest of the forms ANAF actually returns", () => {
    expect(canonicalLegalForm("SOCIETATE COMERCIALĂ PE ACŢIUNI")).toBe("SA");
    expect(canonicalLegalForm("SOCIETATE COMERCIALĂ ÎN NUME COLECTIV")).toBe("SNC");
    expect(canonicalLegalForm("SOCIETATE COMERCIALĂ ÎN COMANDITĂ SIMPLĂ")).toBe("SCS");
    expect(canonicalLegalForm("SOCIETATE EUROPEANĂ")).toBe("SE");
    expect(canonicalLegalForm("PERSOANĂ FIZICĂ AUTORIZATĂ")).toBe("PFA");
    expect(canonicalLegalForm("INTREPRINDERE FAMILIALĂ")).toBe("IF");
    expect(canonicalLegalForm("INTREPRINDERE INDIVIDUALĂ(SAU ÎI)")).toBe("II");
    expect(canonicalLegalForm("REGIE AUTONOMĂ")).toBe("RA");
  });

  it("does not depend on diacritics being written the same way", () => {
    // Two encodings of ş/ș are both in the data, and ANAF is inconsistent.
    expect(canonicalLegalForm("SOCIETATE COMERCIALA PE ACTIUNI")).toBe("SA");
    expect(canonicalLegalForm("societate comercială cu răspundere limitată")).toBe("SRL");
  });
});

describe("ONRC's codes pass through unchanged", () => {
  it("keeps a code as a code", () => {
    expect(canonicalLegalForm("SRL")).toBe("SRL");
    expect(canonicalLegalForm("SA")).toBe("SA");
    expect(canonicalLegalForm("PFA")).toBe("PFA");
  });

  it("strips the punctuation the register sometimes writes", () => {
    expect(canonicalLegalForm("S.R.L.")).toBe("SRL");
    expect(canonicalLegalForm(" srl ")).toBe("SRL");
  });

  it("keeps SRL-D distinct from SRL", () => {
    // A debutant SRL is a younger, differently-regulated company. A caller who
    // wants both says both.
    expect(canonicalLegalForm("SRL-D")).toBe("SRL-D");
  });
});

describe("what it refuses to store", () => {
  it("drops ANAF's own 'we do not know' buckets", () => {
    /*
     * The direction that matters. `ALTE FORME JURIDICE` is "something else" and
     * `N/A` is "unknown"; storing either makes an absent value look recorded,
     * and `--legal-form` excludes unknowns precisely so a sole trader cannot
     * slip through on a missing field.
     */
    expect(canonicalLegalForm("ALTE FORME JURIDICE")).toBeUndefined();
    expect(canonicalLegalForm("N/A")).toBeUndefined();
    expect(canonicalLegalForm("ALT")).toBeUndefined();
  });

  it("drops blank and empty, which ANAF files for 47,348 companies", () => {
    // Same `""`-is-not-null trap as `phone`.
    expect(canonicalLegalForm("")).toBeUndefined();
    expect(canonicalLegalForm("   ")).toBeUndefined();
    expect(canonicalLegalForm(null)).toBeUndefined();
    expect(canonicalLegalForm(undefined)).toBeUndefined();
  });

  it("drops an unrecognised phrase rather than storing a second vocabulary", () => {
    /*
     * The whole point. An unmapped sentence stored raw is how this column ended
     * up holding two spellings of the same thing. Absent shows up as a gap in
     * the mapping; stored, it silently matches nothing forever.
     */
    expect(canonicalLegalForm("SOCIETATE AGRICOLĂ DE TIP NOU")).toBeUndefined();
  });

  it("keeps an unrecognised short code, which is still useful", () => {
    // A code we have not catalogued is more useful stored than dropped — it is
    // comparable, and it is what the register said.
    expect(canonicalLegalForm("OCR")).toBe("OCR");
    expect(canonicalLegalForm("INCD")).toBe("INCD");
  });
});
