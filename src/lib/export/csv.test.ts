import { describe, expect, it } from "vitest";
import {
  csvFilename,
  escapeCell,
  exportLeadsToCsv,
  neutraliseFormula,
  toCsv,
  type ExportableLead,
} from "./csv";

/**
 * Every value in an export originated on someone else's website or in a
 * registry record, and the destination is Excel. That combination is what
 * makes CSV injection a real risk here rather than a theoretical one.
 */

describe("neutraliseFormula", () => {
  it("defuses every formula trigger character", () => {
    // A company that names itself =cmd|'/c calc'!A1 would otherwise execute
    // on the machine of whoever opens the export.
    expect(neutraliseFormula("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(neutraliseFormula("+1234")).toBe("'+1234");
    expect(neutraliseFormula("-1+1")).toBe("'-1+1");
    expect(neutraliseFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutraliseFormula("\tinjected")).toBe("'\tinjected");
  });

  it("leaves ordinary text untouched", () => {
    expect(neutraliseFormula("SmartBill SRL")).toBe("SmartBill SRL");
    expect(neutraliseFormula("ana@firma.ro")).toBe("ana@firma.ro");
    expect(neutraliseFormula("")).toBe("");
  });

  it("only inspects the first character", () => {
    // A hyphen or equals mid-string is not a formula.
    expect(neutraliseFormula("Coca-Cola")).toBe("Coca-Cola");
    expect(neutraliseFormula("a=b")).toBe("a=b");
  });
});

describe("escapeCell", () => {
  it("quotes cells containing the delimiter, quotes or newlines", () => {
    expect(escapeCell("Popescu, Ana", ",")).toBe('"Popescu, Ana"');
    expect(escapeCell('He said "hi"', ",")).toBe('"He said ""hi"""');
    expect(escapeCell("line1\nline2", ",")).toBe('"line1\nline2"');
  });

  it("quotes cells with leading or trailing whitespace", () => {
    // Some readers silently trim these, changing the value.
    expect(escapeCell("  padded  ", ",")).toBe('"  padded  "');
  });

  it("leaves numbers unquoted so the column stays numeric", () => {
    expect(escapeCell(87, ",")).toBe("87");
    expect(escapeCell(1_500_000, ",")).toBe("1500000");
  });

  it("renders empty for null, undefined and non-finite numbers", () => {
    expect(escapeCell(null, ",")).toBe("");
    expect(escapeCell(undefined, ",")).toBe("");
    expect(escapeCell(Number.NaN, ",")).toBe("");
    expect(escapeCell(Number.POSITIVE_INFINITY, ",")).toBe("");
  });

  it("renders booleans as words", () => {
    expect(escapeCell(true, ",")).toBe("true");
    expect(escapeCell(false, ",")).toBe("false");
  });

  it("neutralises and quotes an injection payload containing a comma", () => {
    expect(escapeCell('=HYPERLINK("http://evil","click")', ",")).toBe(
      '"\'=HYPERLINK(""http://evil"",""click"")"',
    );
  });

  it("respects a custom delimiter", () => {
    // Romanian Excel defaults to semicolon separators.
    expect(escapeCell("a;b", ";")).toBe('"a;b"');
    expect(escapeCell("a;b", ",")).toBe("a;b");
  });
});

describe("toCsv", () => {
  type Row = { name: string; score: number };
  const columns = [
    { header: "Name", value: (r: Row) => r.name },
    { header: "Score", value: (r: Row) => r.score },
  ];

  it("writes a header row and CRLF line endings", () => {
    const csv = toCsv([{ name: "Ana", score: 90 }], columns, {
      includeBom: false,
    });
    expect(csv).toBe("Name,Score\r\nAna,90\r\n");
  });

  it("prepends a BOM by default", () => {
    // Without it Excel reads UTF-8 as the local codepage and every Romanian
    // diacritic becomes mojibake.
    const csv = toCsv([{ name: "Ștefan", score: 1 }], columns);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("Ștefan");
  });

  it("emits just a header for no rows", () => {
    expect(toCsv([], columns, { includeBom: false })).toBe("Name,Score\r\n");
  });

  it("keeps column order stable", () => {
    const csv = toCsv([{ name: "A", score: 1 }], columns, { includeBom: false });
    expect(csv.split("\r\n")[0]).toBe("Name,Score");
  });
});

describe("exportLeadsToCsv", () => {
  const lead: ExportableLead = {
    score: 87,
    status: "new",
    whyNow: "Hiring a Marketing Director",
    personName: "Ana Popescu",
    personTitle: "Director General",
    email: "ana.popescu@firma.ro",
    emailStatus: "verified",
    emailConfidence: 0.94,
    companyName: "Firma Test SRL",
    companyDomain: "firma.ro",
    country: "RO",
    county: "Cluj",
    cui: "12345678",
    caen: "6201",
    caenLabel: "Activități de realizare a soft-ului la comandă",
    employees: 45,
    revenueRon: 5_400_000,
    vatRegistered: true,
    topSignal: "Revenue up 40%",
    signalEvidenceUrl: "https://mfinante.gov.ro/x?cui=12345678",
    complianceNote: "Romania: requires prior opt-in — no B2B exemption",
  };

  it("includes the decision-making fields first", () => {
    const csv = exportLeadsToCsv([lead]);
    const header = csv.replace(/^﻿/, "").split("\r\n")[0];
    expect(header.startsWith("Score,Why now,Name,Title,Email")).toBe(true);
  });

  it("converts confidence to a percentage", () => {
    expect(exportLeadsToCsv([lead])).toContain("94");
  });

  it("carries the compliance rule with the data", () => {
    // An exported list gets forwarded; the recipient should see the same rule
    // the app showed.
    expect(exportLeadsToCsv([lead])).toContain("no B2B exemption");
  });

  it("preserves Romanian text", () => {
    expect(exportLeadsToCsv([lead])).toContain("Activități");
  });

  it("handles a lead with almost nothing filled in", () => {
    const sparse: ExportableLead = {
      score: 12,
      status: "new",
      companyName: "Unknown SRL",
    };
    const csv = exportLeadsToCsv([sparse]);
    expect(csv).toContain("Unknown SRL");
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("null");
  });

  it("neutralises an injected company name end to end", () => {
    const malicious: ExportableLead = {
      ...lead,
      companyName: '=cmd|"/c calc"!A1',
    };
    const csv = exportLeadsToCsv([malicious]);
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/,=cmd/);
  });
});

describe("csvFilename", () => {
  it("produces a dated, slugified name", () => {
    expect(csvFilename("Leads export", new Date("2026-06-01"))).toBe(
      "leads-export-2026-06-01.csv",
    );
  });

  it("strips characters that break a filename", () => {
    expect(csvFilename("../../etc/passwd", new Date("2026-06-01"))).toBe(
      "etc-passwd-2026-06-01.csv",
    );
  });

  it("falls back when the prefix slugifies to nothing", () => {
    expect(csvFilename("///", new Date("2026-06-01"))).toBe("export-2026-06-01.csv");
  });
});
