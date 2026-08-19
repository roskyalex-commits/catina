/**
 * ONRC CSV column mapping.
 *
 * **This has never been checked against the real file.** The dataset published
 * on data.gov.ro has no stable published schema, its headers are Romanian, and
 * they have changed between releases. So this is written as a list of aliases
 * per field rather than a fixed set of names, matched case- and
 * diacritic-insensitively, and `npm run import:onrc -- --dry-run` prints what
 * it detected next to what it could not place.
 *
 * When a column turns out to be named something not listed here, the fix is to
 * add the string to the right array below. That is the whole change — nothing
 * downstream names a CSV column.
 */

export type OnrcField =
  | "cui"
  | "name"
  | "regCom"
  | "caen"
  | "caenLabel"
  | "county"
  | "city"
  | "address"
  | "status"
  | "registrationDate"
  | "legalForm";

/**
 * Aliases per field, most likely first. Compared after `normaliseHeader`, so
 * write them however they read — case, diacritics and separators are ignored.
 */
export const ONRC_COLUMN_ALIASES: Record<OnrcField, string[]> = {
  cui: ["cui", "cod unic", "cod unic de inregistrare", "codunic", "cif", "cod fiscal"],
  name: ["denumire", "denumire firma", "nume", "razsociala", "raz sociala"],
  regCom: [
    "cod inmatriculare",
    "nr reg com",
    "numar de ordine in registrul comertului",
    "registrul comertului",
    "nrregcom",
    "euid",
  ],
  caen: ["cod caen", "caen", "cod caen principal", "caen principal", "activitate principala cod"],
  caenLabel: ["denumire caen", "caen denumire", "activitate principala", "obiect de activitate"],
  county: ["judet", "denumire judet", "judetul"],
  city: ["localitate", "denumire localitate", "oras", "municipiu", "comuna"],
  address: ["adresa", "sediu", "adresa sediu", "strada"],
  status: ["stare firma", "stare", "stare societate", "status"],
  registrationDate: [
    "data inregistrare",
    "data inmatriculare",
    "data infiintare",
    "datainregistrarii",
  ],
  legalForm: ["forma juridica", "forma de organizare", "tip societate"],
};

/** Fields without which a row cannot become a company record. */
export const REQUIRED_FIELDS: OnrcField[] = ["cui", "name"];

/**
 * Fold a header cell to its comparison form: lower case, no diacritics, and
 * separators collapsed to single spaces.
 *
 * Romanian headers arrive with and without diacritics depending on who
 * exported them — `JUDEȚ`, `JUDET` and `Judetul` are the same column, and
 * `COD_CAEN`, `Cod CAEN` and `cod-caen` are too.
 */
export function normaliseHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // ș and ț are sometimes the cedilla codepoints, which NFD does not split.
    .replace(/[şŞ]/g, "s")
    .replace(/[ţŢ]/g, "t")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type ColumnMap = Partial<Record<OnrcField, number>>;

export type HeaderReport = {
  /** Field → column index, for every field that was located. */
  map: ColumnMap;
  /** Fields with no matching column. */
  missing: OnrcField[];
  /** Header cells that matched nothing, so an unknown column is visible. */
  unmapped: string[];
  /** True when every field in `REQUIRED_FIELDS` was found. */
  usable: boolean;
};

/**
 * Locate each field in the header row.
 *
 * Exact matches win over prefix matches, and an earlier alias wins over a later
 * one, so a file carrying both `CUI` and `CUI_PLATITOR` maps the bare one.
 * Nothing is guessed positionally: a wrong column silently importing wrong data
 * is worse than a missing one, which `--dry-run` will show.
 */
export function mapHeader(header: string[]): HeaderReport {
  const normalised = header.map(normaliseHeader);
  const map: ColumnMap = {};
  const claimed = new Set<number>();

  for (const [field, aliases] of Object.entries(ONRC_COLUMN_ALIASES) as [
    OnrcField,
    string[],
  ][]) {
    let found: number | undefined;

    for (const alias of aliases) {
      const exact = normalised.findIndex(
        (cell, i) => cell === alias && !claimed.has(i),
      );
      if (exact !== -1) {
        found = exact;
        break;
      }
    }

    if (found === undefined) {
      for (const alias of aliases) {
        const partial = normalised.findIndex(
          (cell, i) =>
            !claimed.has(i) && (cell.startsWith(alias) || cell.endsWith(alias)),
        );
        if (partial !== -1) {
          found = partial;
          break;
        }
      }
    }

    if (found !== undefined) {
      map[field] = found;
      claimed.add(found);
    }
  }

  const missing = (Object.keys(ONRC_COLUMN_ALIASES) as OnrcField[]).filter(
    (field) => map[field] === undefined,
  );

  return {
    map,
    missing,
    unmapped: header.filter((_, i) => !claimed.has(i)),
    usable: REQUIRED_FIELDS.every((field) => map[field] !== undefined),
  };
}

/** Human-readable header report — what `--dry-run` prints. */
export function describeHeader(header: string[], report: HeaderReport): string {
  const lines = ["Detected columns:"];
  for (const [field, index] of Object.entries(report.map) as [
    OnrcField,
    number,
  ][]) {
    lines.push(`  ${field.padEnd(17)} <- [${index}] ${header[index]}`);
  }
  if (report.missing.length) {
    lines.push("", `Not found: ${report.missing.join(", ")}`);
  }
  if (report.unmapped.length) {
    lines.push("", `Columns nothing claimed: ${report.unmapped.join(", ")}`);
  }
  if (!report.usable) {
    lines.push(
      "",
      `Cannot import: ${REQUIRED_FIELDS.join(" and ")} are required.`,
      "Add the real header names to ONRC_COLUMN_ALIASES in",
      "src/lib/sources/onrc/columns.ts — that is the only change needed.",
    );
  }
  return lines.join("\n");
}
