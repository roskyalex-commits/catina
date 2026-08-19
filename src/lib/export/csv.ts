/**
 * CSV export.
 *
 * The non-obvious risk: every field here originated on someone else's website
 * or in a registry record, and the file's destination is Excel. A cell whose
 * value begins with `=`, `+`, `-` or `@` is interpreted as a formula, so a
 * company that names itself `=cmd|'/c calc'!A1` executes on the machine of
 * whoever opens the export. That is CSV injection, and the export path is the
 * one place in this product where untrusted text reaches a formula engine.
 *
 * Neutralising it costs one character and is done unconditionally.
 */

export type CsvColumn<T> = {
  header: string;
  /** Return null/undefined for an empty cell rather than the string "null". */
  value: (row: T) => string | number | boolean | null | undefined;
};

export type CsvOptions = {
  delimiter?: string;
  /**
   * Excel reads a bare UTF-8 file as the local codepage, which turns every
   * Romanian diacritic into mojibake. The BOM is what prevents that, and this
   * export is Romania-first, so it defaults on.
   */
  includeBom?: boolean;
  /** CRLF is what Excel expects; RFC 4180 requires it. */
  newline?: "\r\n" | "\n";
};

const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/**
 * Prevents a cell being read as a formula.
 *
 * A leading apostrophe would also work in Excel but corrupts the value for
 * every other consumer. A tab prefix is the conventional alternative but is
 * itself a trigger character. Prefixing with a single quote *inside* a quoted
 * cell is the widely-recommended approach and is what Google Sheets and Excel
 * both honour.
 */
export function neutraliseFormula(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix))
    ? `'${value}`
    : value;
}

/** RFC 4180 quoting: double the quotes, wrap when the cell contains specials. */
export function escapeCell(
  raw: string | number | boolean | null | undefined,
  delimiter: string,
): string {
  if (raw === null || raw === undefined) return "";

  // Booleans and numbers can't carry an injection payload, and quoting them
  // would make the column non-numeric in every spreadsheet that opens it.
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  if (typeof raw === "boolean") return raw ? "true" : "false";

  const value = neutraliseFormula(raw);
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    // Leading/trailing spaces are silently trimmed by some readers.
    value !== value.trim();

  return needsQuoting ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv<T>(
  rows: T[],
  columns: CsvColumn<T>[],
  options: CsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ",";
  const newline = options.newline ?? "\r\n";
  const bom = options.includeBom ?? true ? "﻿" : "";

  const lines = [
    columns.map((c) => escapeCell(c.header, delimiter)).join(delimiter),
    ...rows.map((row) =>
      columns.map((c) => escapeCell(c.value(row), delimiter)).join(delimiter),
    ),
  ];

  return bom + lines.join(newline) + newline;
}

/** Safe, dated filename. */
export function csvFilename(prefix: string, now = new Date()): string {
  const slug = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${slug || "export"}-${now.toISOString().slice(0, 10)}.csv`;
}

/* ------------------------------------------------------------ lead export */

export type ExportableLead = {
  score: number;
  status: string;
  whyNow?: string;
  personName?: string;
  personTitle?: string;
  personLinkedin?: string;
  email?: string;
  emailStatus?: string;
  emailConfidence?: number;
  companyName: string;
  companyDomain?: string;
  country?: string;
  city?: string;
  county?: string;
  cui?: string;
  caen?: string;
  caenLabel?: string;
  employees?: number;
  revenueRon?: number;
  vatRegistered?: boolean;
  topSignal?: string;
  signalEvidenceUrl?: string;
  complianceNote?: string;
};

/**
 * Column order matters: this file is opened in a spreadsheet and skimmed
 * left-to-right, so the decision-making fields come first and the registry
 * detail trails behind.
 */
export const LEAD_EXPORT_COLUMNS: CsvColumn<ExportableLead>[] = [
  { header: "Score", value: (l) => l.score },
  { header: "Why now", value: (l) => l.whyNow },
  { header: "Name", value: (l) => l.personName },
  { header: "Title", value: (l) => l.personTitle },
  { header: "Email", value: (l) => l.email },
  { header: "Email status", value: (l) => l.emailStatus },
  {
    header: "Email confidence",
    // Percentages read better than 0-1 floats in a spreadsheet.
    value: (l) =>
      l.emailConfidence === undefined
        ? undefined
        : Math.round(l.emailConfidence * 100),
  },
  { header: "Company", value: (l) => l.companyName },
  { header: "Domain", value: (l) => l.companyDomain },
  { header: "Country", value: (l) => l.country },
  { header: "County", value: (l) => l.county },
  { header: "City", value: (l) => l.city },
  { header: "CUI", value: (l) => l.cui },
  { header: "CAEN", value: (l) => l.caen },
  { header: "CAEN activity", value: (l) => l.caenLabel },
  { header: "Employees", value: (l) => l.employees },
  { header: "Revenue (RON)", value: (l) => l.revenueRon },
  { header: "VAT registered", value: (l) => l.vatRegistered },
  { header: "Top signal", value: (l) => l.topSignal },
  { header: "Signal source", value: (l) => l.signalEvidenceUrl },
  { header: "LinkedIn", value: (l) => l.personLinkedin },
  // Travels with the data on purpose: an exported list gets forwarded, and
  // the person who receives it should see the same rule the app showed.
  { header: "Outreach rule", value: (l) => l.complianceNote },
  { header: "Status", value: (l) => l.status },
];

export function exportLeadsToCsv(leads: ExportableLead[]): string {
  return toCsv(leads, LEAD_EXPORT_COLUMNS);
}
