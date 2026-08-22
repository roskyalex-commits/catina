import { describe, expect, it } from "vitest";
import type { SourcedCompany } from "@/lib/sources/types";
import { parseCsv, readRecords, sniffDelimiter, splitRow, stripBom } from "./csv";
import { describeHeader, mapHeader, normaliseHeader } from "./columns";
import {
  canonicalCounty,
  isActiveStatus,
  matchesFilter,
  parseCaenCode,
  parseRomanianDate,
  parseRow,
} from "./parse";

/**
 * The ONRC file has never been seen (docs/STATUS.md), so these tests pin the
 * behaviour that has to survive first contact with it: the delimiter and the
 * header names are discovered rather than assumed, and anything unparseable
 * becomes absent rather than a guess.
 */

describe("sniffDelimiter", () => {
  it("picks the semicolon a ro-RO Excel export writes", () => {
    expect(sniffDelimiter("CUI;DENUMIRE;JUDET;COD_CAEN")).toBe(";");
  });

  it("picks the comma for a plain RFC 4180 header", () => {
    expect(sniffDelimiter("cui,denumire,judet")).toBe(",");
  });

  it("is not fooled by commas inside a quoted header cell", () => {
    // The case that makes a naive comma count pick the wrong delimiter.
    expect(sniffDelimiter('CUI;"Adresa, completa";JUDET')).toBe(";");
  });

  it("falls back to comma for a single-column file", () => {
    expect(sniffDelimiter("CUI")).toBe(",");
  });
});

describe("splitRow", () => {
  it("splits plain fields", () => {
    expect(splitRow("1;2;3", ";")).toEqual(["1", "2", "3"]);
  });

  it("keeps a delimiter inside quotes", () => {
    expect(splitRow('14399840;"Str. Mare, nr. 1";Cluj', ";")).toEqual([
      "14399840",
      "Str. Mare, nr. 1",
      "Cluj",
    ]);
  });

  it("reads a doubled quote as a literal quote", () => {
    expect(splitRow('a;"say ""hi""";b', ";")).toEqual(["a", 'say "hi"', "b"]);
  });

  it("preserves empty trailing fields", () => {
    expect(splitRow("a;;", ";")).toEqual(["a", "", ""]);
  });

  it("keeps Romanian diacritics intact", () => {
    expect(splitRow("Brașov;Bistrița-Năsăud", ";")).toEqual([
      "Brașov",
      "Bistrița-Năsăud",
    ]);
  });
});

describe("stripBom", () => {
  it("removes the BOM Excel writes, which would corrupt column one", () => {
    expect(stripBom("﻿CUI;DENUMIRE")).toBe("CUI;DENUMIRE");
  });

  it("leaves a file without one alone", () => {
    expect(stripBom("CUI;DENUMIRE")).toBe("CUI;DENUMIRE");
  });
});

describe("readRecords", () => {
  async function* chunks(...parts: string[]) {
    for (const part of parts) yield part;
  }
  async function collect(...parts: string[]) {
    const out: string[] = [];
    for await (const record of readRecords(chunks(...parts))) out.push(record);
    return out;
  }

  it("yields one record per line", async () => {
    expect(await collect("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("handles CRLF", async () => {
    expect(await collect("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("reassembles a record split across chunk boundaries", async () => {
    // The property that matters for a 4M-row file read in 64KB pieces.
    expect(await collect("14399840;Dede", "man SRL\nnext;row")).toEqual([
      "14399840;Dedeman SRL",
      "next;row",
    ]);
  });

  it("does not split on a newline inside a quoted field", async () => {
    expect(await collect('a;"line one\nline two";b\nsecond')).toEqual([
      'a;"line one\nline two";b',
      "second",
    ]);
  });

  it("emits a final line with no trailing newline", async () => {
    expect(await collect("a\nb")).toEqual(["a", "b"]);
  });

  it("strips the BOM from the first chunk only", async () => {
    expect(await collect("﻿a\n﻿b")).toEqual(["a", "﻿b"]);
  });
});

describe("normaliseHeader", () => {
  it("folds case, diacritics and separators", () => {
    expect(normaliseHeader("COD_CAEN")).toBe("cod caen");
    expect(normaliseHeader("Judeţul")).toBe("judetul");
    expect(normaliseHeader("JUDEȚ")).toBe("judet");
  });

  it("folds the cedilla codepoints NFD does not split", () => {
    // ş/ţ (cedilla) and ș/ț (comma-below) both occur in Romanian exports.
    expect(normaliseHeader("Stare firmă")).toBe(normaliseHeader("STARE FIRMA"));
  });
});

describe("mapHeader", () => {
  it("locates the columns of a plausible export", () => {
    const header = [
      "CUI",
      "DENUMIRE",
      "COD_INMATRICULARE",
      "COD_CAEN",
      "JUDET",
      "LOCALITATE",
      "STARE_FIRMA",
      "DATA_INREGISTRARE",
    ];
    const report = mapHeader(header);
    expect(report.usable).toBe(true);
    expect(report.map.cui).toBe(0);
    expect(report.map.name).toBe(1);
    expect(report.map.caen).toBe(3);
    expect(report.map.county).toBe(4);
    expect(report.map.status).toBe(6);
    expect(report.map.registrationDate).toBe(7);
  });

  it("matches regardless of diacritics or separators", () => {
    const report = mapHeader(["Cod Unic", "Denumire firmă", "Judeţul"]);
    expect(report.map.cui).toBe(0);
    expect(report.map.name).toBe(1);
    expect(report.map.county).toBe(2);
  });

  it("prefers the bare column when a longer one shares the prefix", () => {
    const report = mapHeader(["CUI_PLATITOR", "CUI", "DENUMIRE"]);
    expect(report.map.cui).toBe(1);
  });

  it("never assigns one column to two fields", () => {
    const report = mapHeader(["CUI", "DENUMIRE", "COD_CAEN", "DENUMIRE_CAEN"]);
    const used = Object.values(report.map);
    expect(new Set(used).size).toBe(used.length);
  });

  it("reports a file it cannot import instead of guessing positionally", () => {
    const report = mapHeader(["col_a", "col_b", "col_c"]);
    expect(report.usable).toBe(false);
    expect(report.missing).toContain("cui");
    expect(report.unmapped).toEqual(["col_a", "col_b", "col_c"]);
  });

  it("lists columns nothing claimed, so an unknown one is visible", () => {
    const report = mapHeader(["CUI", "DENUMIRE", "CIFRA_DE_AFACERI"]);
    expect(report.unmapped).toEqual(["CIFRA_DE_AFACERI"]);
  });
});

describe("describeHeader", () => {
  it("names the file and const to edit when the header cannot be mapped", () => {
    const header = ["col_a", "col_b"];
    const text = describeHeader(header, mapHeader(header));
    expect(text).toContain("ONRC_COLUMN_ALIASES");
    expect(text).toContain("columns.ts");
  });
});

describe("canonicalCounty", () => {
  it("resolves a registration code", () => {
    expect(canonicalCounty("CJ")).toBe("Cluj");
    expect(canonicalCounty("B")).toBe("București");
  });

  it("resolves a name with or without diacritics", () => {
    expect(canonicalCounty("Brasov")).toBe("Brașov");
    expect(canonicalCounty("Brașov")).toBe("Brașov");
    expect(canonicalCounty("bistrita-nasaud")).toBe("Bistrița-Năsăud");
  });

  it("strips the jud. prefix the register sometimes carries", () => {
    expect(canonicalCounty("jud. Timis")).toBe("Timiș");
    expect(canonicalCounty("Județ Iasi")).toBe("Iași");
  });

  it("recognises Bucharest under its longer spellings", () => {
    expect(canonicalCounty("Municipiul Bucuresti")).toBe("București");
  });

  it("keeps an unrecognised county rather than dropping it", () => {
    expect(canonicalCounty("Chisinau")).toBe("Chisinau");
  });

  it("returns undefined for an empty cell", () => {
    expect(canonicalCounty("   ")).toBeUndefined();
  });
});

describe("parseRomanianDate", () => {
  it("reads the dotted Romanian form as day-first", () => {
    // 3 April, not 4 March — the whole point of assuming day-first here.
    expect(parseRomanianDate("03.04.2019")).toBe("2019-04-03");
  });

  it("reads slashes as day-first too", () => {
    expect(parseRomanianDate("23/04/2019")).toBe("2019-04-23");
  });

  it("reads ISO unchanged", () => {
    expect(parseRomanianDate("2019-04-23")).toBe("2019-04-23");
  });

  it("rejects an impossible date rather than rolling it over", () => {
    expect(parseRomanianDate("31.02.2019")).toBeUndefined();
    expect(parseRomanianDate("45.01.2019")).toBeUndefined();
  });

  it("rejects a year outside the register's range", () => {
    expect(parseRomanianDate("01.01.1500")).toBeUndefined();
  });

  it("returns undefined for junk instead of an epoch date", () => {
    expect(parseRomanianDate("n/a")).toBeUndefined();
    expect(parseRomanianDate("")).toBeUndefined();
  });
});

describe("parseCaenCode", () => {
  it("reads a bare code", () => {
    expect(parseCaenCode("4791")).toBe("4791");
  });

  it("reads a code with its label attached", () => {
    expect(parseCaenCode("4791 - Comerț cu amănuntul prin internet")).toBe("4791");
  });

  it("pads a code a spreadsheet stripped the leading zero from", () => {
    expect(parseCaenCode("111")).toBe("0111");
  });

  it("returns undefined when there is no code", () => {
    expect(parseCaenCode("")).toBeUndefined();
    expect(parseCaenCode("n/a")).toBeUndefined();
  });
});

describe("isActiveStatus", () => {
  it("recognises trading", () => {
    expect(isActiveStatus("FUNCTIUNE")).toBe(true);
    expect(isActiveStatus("în funcțiune")).toBe(true);
  });

  it("recognises the ways a company stops trading", () => {
    expect(isActiveStatus("RADIATA")).toBe(false);
    expect(isActiveStatus("dizolvare")).toBe(false);
    expect(isActiveStatus("in faliment")).toBe(false);
    expect(isActiveStatus("INSOLVENTA")).toBe(false);
  });

  it("recognises the verb and the noun form alike", () => {
    // Romanian inflects these and the register uses both.
    for (const pair of [
      ["dizolvata", "dizolvare"],
      ["radiata", "radiere"],
      ["lichidata", "lichidare"],
      ["suspendata", "suspendare"],
    ]) {
      expect(pair.map(isActiveStatus)).toEqual([false, false]);
    }
  });

  it("does not read INACTIV as active", () => {
    // "inactiv" contains "activ" — the substring test has to exclude it first.
    expect(isActiveStatus("INACTIV")).toBe(false);
    expect(isActiveStatus("contribuabil inactiv")).toBe(false);
  });

  it("returns null for wording it does not recognise", () => {
    // Not false: an unrecognised status must not silently drop the file.
    expect(isActiveStatus("ceva nou")).toBeNull();
    expect(isActiveStatus("")).toBeNull();
    expect(isActiveStatus(undefined)).toBeNull();
  });
});

describe("parseRow", () => {
  const map = {
    cui: 0,
    name: 1,
    regCom: 2,
    caen: 3,
    county: 4,
    city: 5,
    status: 6,
    registrationDate: 7,
  };
  const row = [
    "RO 14399840",
    "DEDEMAN SRL",
    "J08/1234/1993",
    "4752",
    "jud. Bacau",
    "Bacău",
    "FUNCTIUNE",
    "12.05.1993",
  ];

  it("maps a well-formed row", () => {
    const result = parseRow(row, map);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.cui).toBe("14399840");
    expect(result.company.name).toBe("DEDEMAN SRL");
    expect(result.company.caen).toBe("4752");
    expect(result.company.county).toBe("Bacău");
    expect(result.company.regCom).toBe("J08/1234/1993");
    expect(result.company.registrationDate).toBe("1993-05-12");
    expect(result.company.country).toBe("RO");
    expect(result.company.source).toBe("onrc");
  });

  it("normalises a CUI written as a VAT number", () => {
    const result = parseRow(row, map);
    expect(result.ok && result.company.cui).toBe("14399840");
  });

  it("keys on the CUI, since the register carries no domain", () => {
    const result = parseRow(row, map);
    expect(result.ok && result.company.dedupeKey).toBe("cui:14399840");
  });

  it("carries the register's own status wording alongside, not inside", () => {
    const result = parseRow(row, map);
    expect(result.ok && result.status).toBe("FUNCTIUNE");
  });

  it("falls back to our CAEN label when the file has none", () => {
    const result = parseRow(row, map);
    expect(result.ok && result.company.caenLabel).toBeTruthy();
  });

  it("rejects a row with no CUI", () => {
    const result = parseRow(["", "X"], { cui: 0, name: 1 });
    expect(result).toEqual({ ok: false, reason: "missing_cui" });
  });

  it("rejects a CUI that is not a CUI", () => {
    const result = parseRow(["not-a-cui", "X"], { cui: 0, name: 1 });
    expect(result).toEqual({ ok: false, reason: "invalid_cui" });
  });

  it("rejects a row with no name", () => {
    const result = parseRow(["14399840", "  "], { cui: 0, name: 1 });
    expect(result).toEqual({ ok: false, reason: "missing_name" });
  });

  it("omits fields whose columns were never found", () => {
    const result = parseRow(["14399840", "X"], { cui: 0, name: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.caen).toBeUndefined();
    expect(result.company.county).toBeUndefined();
    expect(result.company.registrationDate).toBeUndefined();
  });

  it("tolerates a row shorter than the header", () => {
    // A ragged final line should not throw mid-import.
    const result = parseRow(["14399840", "X"], map);
    expect(result.ok).toBe(true);
  });
});

describe("matchesFilter", () => {
  const company = {
    dedupeKey: "cui:1",
    name: "X",
    caen: "6201",
    county: "Cluj",
    source: "onrc",
  };

  it("passes everything when no filter is set", () => {
    expect(matchesFilter(company, undefined, {})).toBe(true);
  });

  it("matches an exact CAEN code", () => {
    expect(matchesFilter(company, undefined, { caen: ["6201"] })).toBe(true);
    expect(matchesFilter(company, undefined, { caen: ["4791"] })).toBe(false);
  });

  it("matches a two-digit division against the whole division", () => {
    expect(matchesFilter(company, undefined, { caen: ["62"] })).toBe(true);
    expect(matchesFilter(company, undefined, { caen: ["47"] })).toBe(false);
  });

  it("excludes a company with no CAEN when filtering on one", () => {
    const noCaen = { ...company, caen: undefined };
    expect(matchesFilter(noCaen, undefined, { caen: ["6201"] })).toBe(false);
  });

  it("keeps only the legal forms asked for", () => {
    /*
     * The lever that separates a company from a sole trader. A quarter of the
     * register — 328,995 PFA and 114,171 II — is one person trading under their
     * own name, where "administrator" is the whole business rather than a
     * decision-maker inside one.
     */
    const srl = { ...company, legalForm: "SRL" };
    const pfa = { ...company, legalForm: "PFA" };
    expect(matchesFilter(srl, undefined, { legalForm: ["SRL", "SA"] })).toBe(true);
    expect(matchesFilter(pfa, undefined, { legalForm: ["SRL", "SA"] })).toBe(false);
  });

  it("ignores the punctuation the register writes the form with", () => {
    // `S.R.L.`, `SRL` and `Srl` are all the same thing in the file.
    const dotted = { ...company, legalForm: "SRL" };
    expect(matchesFilter(dotted, undefined, { legalForm: ["S.R.L."] })).toBe(true);
    expect(matchesFilter(dotted, undefined, { legalForm: ["srl"] })).toBe(true);
  });

  it("excludes a company whose legal form is unknown", () => {
    /*
     * Excluding, not admitting. The filter exists to keep sole traders out, and
     * an unrecorded form is exactly the case where letting it through would
     * defeat the point of setting it.
     */
    expect(matchesFilter(company, undefined, { legalForm: ["SRL"] })).toBe(false);
  });

  it("does not distinguish SRL-D from SRL unless asked to", () => {
    // A debutant SRL is a genuinely different, younger company. A caller who
    // wants both says so; one who writes "SRL" gets SRL.
    const debutant = { ...company, legalForm: "SRL-D" };
    expect(matchesFilter(debutant, undefined, { legalForm: ["SRL"] })).toBe(false);
    expect(matchesFilter(debutant, undefined, { legalForm: ["SRL", "SRL-D"] })).toBe(true);
  });

  it("matches a county given as a code or an unaccented name", () => {
    expect(matchesFilter(company, undefined, { county: ["CJ"] })).toBe(true);
    expect(matchesFilter(company, undefined, { county: ["cluj"] })).toBe(true);
    expect(matchesFilter(company, undefined, { county: ["Timis"] })).toBe(false);
  });

  it("drops a dissolved company under activeOnly", () => {
    expect(matchesFilter(company, "RADIATA", { activeOnly: true })).toBe(false);
  });

  it("keeps a company whose status wording is unrecognised", () => {
    // Unknown must not mean gone, or a wording change empties the import.
    expect(matchesFilter(company, "ceva nou", { activeOnly: true })).toBe(true);
    expect(matchesFilter(company, undefined, { activeOnly: true })).toBe(true);
  });
});

describe("parseCsv end to end", () => {
  it("reads a plausible ro-RO export into companies", () => {
    const file =
      "﻿CUI;DENUMIRE;COD_CAEN;JUDET;STARE_FIRMA;DATA_INREGISTRARE\r\n" +
      "14399840;DEDEMAN SRL;4752;BC;FUNCTIUNE;12.05.1993\r\n" +
      '6300978;"BANCA TRANSILVANIA, SA";6419;CJ;FUNCTIUNE;16.12.1993\r\n';

    const { delimiter, header, rows } = parseCsv(file);
    expect(delimiter).toBe(";");

    const report = mapHeader(header);
    expect(report.usable).toBe(true);

    const parsed = rows.map((row) => parseRow(row, report.map));
    expect(parsed.every((p) => p.ok)).toBe(true);

    const companies = parsed.flatMap((p) => (p.ok ? [p.company] : []));
    expect(companies.map((c) => c.name)).toEqual([
      "DEDEMAN SRL",
      "BANCA TRANSILVANIA, SA",
    ]);
    expect(companies.map((c) => c.county)).toEqual(["Bacău", "Cluj"]);
    expect(companies[1].caen).toBe("6419");
  });
});

describe("matchesFilter — hasWebsite", () => {
  /**
   * The densest slice in the register: 11,050 companies nationally out of 4.0M
   * rows carry a usable website, and a domain is the one input the email
   * pipeline cannot work without.
   */
  const base: SourcedCompany = {
    dedupeKey: "x",
    name: "TEST SRL",
    country: "RO",
    source: "onrc",
  };

  it("keeps a company with a parsed domain", () => {
    expect(
      matchesFilter({ ...base, domain: "firma.ro" }, undefined, { hasWebsite: true }),
    ).toBe(true);
  });

  it("drops one with nothing in the website column", () => {
    expect(matchesFilter(base, undefined, { hasWebsite: true })).toBe(false);
  });

  it("drops one whose website column held junk", () => {
    // A real row: the phone number 0744700293 sits in the website column.
    // `extractDomain` refuses it, so `domain` is undefined and this must drop —
    // filtering on the raw column instead would import a company with no site.
    expect(
      matchesFilter({ ...base, website: "0744700293" }, undefined, { hasWebsite: true }),
    ).toBe(false);
  });

  it("does not affect anything when it is off", () => {
    expect(matchesFilter(base, undefined, {})).toBe(true);
  });
});
