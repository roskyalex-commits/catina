import { normaliseCui } from "@/lib/sources/anaf/client";
import { caenLabel, isValidCaen } from "@/lib/sources/caen";
import type { SourcedCompany } from "@/lib/sources/types";
import { normaliseHeader, type ColumnMap } from "./columns";

/**
 * ONRC row → `SourcedCompany`.
 *
 * Parses defensively throughout, for the reason in docs/STATUS.md: the file has
 * never been observed. Every field is optional, a value that fails to parse
 * becomes absent rather than a guess, and a row missing a CUI or a name is
 * rejected with a reason instead of imported half-formed.
 */

export const ONRC_SOURCE_KEY = "onrc";

/** The 41 counties plus Bucharest, keyed by their vehicle-registration codes. */
export const COUNTY_CODES: Record<string, string> = {
  AB: "Alba", AR: "Arad", AG: "Argeș", BC: "Bacău", BH: "Bihor",
  BN: "Bistrița-Năsăud", BT: "Botoșani", BV: "Brașov", BR: "Brăila",
  B: "București", BZ: "Buzău", CS: "Caraș-Severin", CL: "Călărași",
  CJ: "Cluj", CT: "Constanța", CV: "Covasna", DB: "Dâmbovița", DJ: "Dolj",
  GL: "Galați", GR: "Giurgiu", GJ: "Gorj", HR: "Harghita", HD: "Hunedoara",
  IL: "Ialomița", IS: "Iași", IF: "Ilfov", MM: "Maramureș", MH: "Mehedinți",
  MS: "Mureș", NT: "Neamț", OT: "Olt", PH: "Prahova", SM: "Satu Mare",
  SJ: "Sălaj", SB: "Sibiu", SV: "Suceava", TR: "Teleorman", TM: "Timiș",
  TL: "Tulcea", VS: "Vaslui", VL: "Vâlcea", VN: "Vrancea",
};

/**
 * Resolve a county to its canonical name.
 *
 * Accepts the registration code (`CJ`), the name with diacritics (`Cluj`), the
 * name without them, and the `jud. X` prefix the register sometimes carries.
 * An unrecognised value is returned trimmed rather than dropped — a county we
 * cannot place is still better data than none.
 */
export function canonicalCounty(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/^jud(?:e[țt]?)?\.?\s+/i, "");
  if (!trimmed) return undefined;

  const upper = trimmed.toUpperCase();
  if (COUNTY_CODES[upper]) return COUNTY_CODES[upper];

  const folded = normaliseHeader(trimmed);
  for (const name of Object.values(COUNTY_CODES)) {
    if (normaliseHeader(name) === folded) return name;
  }
  // Bucharest appears under several spellings and is the single largest slice.
  if (folded.startsWith("bucuresti") || folded.endsWith("bucuresti")) {
    return "București";
  }
  return trimmed;
}

function validDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // Anything before 1900 or in the future is a parse error, not a very old
  // company — the trade register itself only dates from 1990.
  if (year < 1900 || year > new Date().getUTCFullYear() + 1) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Parse a date the register might write several ways.
 *
 * Accepts ISO (`2019-04-23`), Romanian `DD.MM.YYYY` and `DD/MM/YYYY`, and
 * returns an ISO date string. Day-first is assumed for the dotted and slashed
 * forms because the source is Romanian: `03.04.2019` is 3 April, not 4 March.
 * Getting this backwards would not throw — it would quietly file a third of
 * every year's registrations under the wrong month.
 */
export function parseRomanianDate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);

  const dayFirst = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(value);
  if (dayFirst) return validDate(+dayFirst[3], +dayFirst[2], +dayFirst[1]);

  return undefined;
}

/**
 * Extract a 4-digit CAEN code.
 *
 * The column sometimes carries the code alone and sometimes `4791 - Comerț…`.
 * A 3-digit value is left-padded, which is how codes below 1000 appear once a
 * spreadsheet has stripped the leading zero.
 */
export function parseCaenCode(raw: string): string | undefined {
  const match = /\d{3,4}/.exec(raw.trim());
  if (!match) return undefined;
  const code = match[0].padStart(4, "0");
  return isValidCaen(code) ? code : undefined;
}

/**
 * Whether the register considers the company trading.
 *
 * Returns null when the status is absent or unrecognised — deliberately not
 * false. Treating an unknown status as dissolved would silently drop most of
 * the file the first time the wording changes, and the wording is exactly the
 * thing that has never been seen.
 */
export function isActiveStatus(raw: string | undefined): boolean | null {
  if (!raw?.trim()) return null;
  const folded = normaliseHeader(raw);

  // Stems, not whole words: Romanian inflects these, and the register uses the
  // verb and the noun interchangeably — "DIZOLVATA" and "DIZOLVARE" are the
  // same fact. Matching whole words would recognise one and miss the other.
  const dead = [
    "inactiv", // must precede the "activ" test below, which it contains
    "radi", // radiat, radiată, radiere
    "dizolv", // dizolvat, dizolvare
    "lichid", // lichidat, lichidare
    "faliment",
    "insolvent",
    "suspend", // suspendat, suspendare
    "intrerup", // întrerupt, întrerupere
  ];
  if (dead.some((term) => folded.includes(term))) return false;
  if (folded.includes("functiune") || folded.includes("activ")) return true;
  return null;
}

/**
 * A parsed row.
 *
 * `status` rides alongside the company rather than inside it: `SourcedCompany`
 * is the shape every adapter produces and has no field for the register's own
 * wording, but the `companies.onrc_status` column keeps it verbatim. Flattening
 * it into a boolean at parse time would throw away the only text that says
 * *why* a company is not trading.
 */
export type ParsedRow =
  | { ok: true; company: SourcedCompany; status?: string }
  | { ok: false; reason: "missing_cui" | "invalid_cui" | "missing_name" };

/** Map one split CSV row through the detected column positions. */
export function parseRow(row: string[], map: ColumnMap): ParsedRow {
  const at = (field: keyof ColumnMap): string => {
    const index = map[field];
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const rawCui = at("cui");
  if (!rawCui) return { ok: false, reason: "missing_cui" };

  const cui = normaliseCui(rawCui);
  if (!cui) return { ok: false, reason: "invalid_cui" };

  const name = at("name");
  if (!name) return { ok: false, reason: "missing_name" };

  const company: SourcedCompany = {
    // The register carries no domain; the crawler fills that in later, so the
    // documented `cui:` fallback is the dedupe key for every row here.
    dedupeKey: `cui:${cui}`,
    name,
    cui,
    country: "RO",
    source: ONRC_SOURCE_KEY,
  };

  const caen = parseCaenCode(at("caen"));
  if (caen) {
    company.caen = caen;
    // The file's own label wins; ours is the fallback for an uncurated code.
    company.caenLabel = at("caenLabel") || caenLabel(caen);
  }

  const county = canonicalCounty(at("county"));
  if (county) company.county = county;

  const city = at("city");
  if (city) company.city = city;

  const regCom = at("regCom");
  if (regCom) company.regCom = regCom;

  const legalForm = normaliseLegalForm(at("legalForm"));
  if (legalForm) company.legalForm = legalForm;

  const registrationDate = parseRomanianDate(at("registrationDate"));
  if (registrationDate) company.registrationDate = registrationDate;

  const status = at("status");
  return status ? { ok: true, company, status } : { ok: true, company };
}

/**
 * Fold a legal form to compare it.
 *
 * The register writes `S.R.L.`, `SRL`, `Srl` and `SRL-D` for what a filter
 * means by "SRL". Punctuation and case come out; the `-D` does not, because a
 * `SRL-D` (debutant) is a genuinely different, younger company and a caller may
 * reasonably want one and not the other.
 */
export function normaliseLegalForm(raw: string): string | undefined {
  const value = raw.replace(/\./g, "").trim().toUpperCase();
  return value || undefined;
}

export type RowFilter = {
  /** 4-digit CAEN codes, or 2-digit divisions to match a whole division. */
  caen?: string[];
  /** County names or registration codes; matched canonically. */
  county?: string[];
  /**
   * Legal forms to keep, e.g. `["SRL", "SA"]`.
   *
   * The lever that separates companies from sole traders. Of the 1,777,974
   * trading entities in the register, **328,995 are PFA and 114,171 are II** —
   * a quarter of it — and for those the register's "administrator" is simply
   * the person, not a decision-maker inside an organisation.
   */
  legalForm?: string[];
  /** Drop companies the register marks dissolved, radiated or insolvent. */
  activeOnly?: boolean;
  /**
   * Keep only companies the register lists a usable website for.
   *
   * The densest slice there is. A domain is the one input the email pipeline
   * cannot work without — measured, 26% of companies with a domain publish a
   * role address — and the register carries one for 11,050 companies
   * nationally out of 4.0M rows. Importing that 0.27% costs almost nothing and
   * is worth more than any county.
   */
  hasWebsite?: boolean;
};

/** Does this company pass the CLI's filters? */
export function matchesFilter(
  company: SourcedCompany,
  status: string | undefined,
  filter: RowFilter,
): boolean {
  if (filter.caen?.length) {
    const code = company.caen;
    if (!code) return false;
    const hit = filter.caen.some((wanted) =>
      wanted.length === 2 ? code.startsWith(wanted) : code === wanted,
    );
    if (!hit) return false;
  }

  if (filter.county?.length) {
    const wanted = filter.county
      .map(canonicalCounty)
      .filter((name): name is string => Boolean(name));
    if (!company.county || !wanted.includes(company.county)) return false;
  }

  if (filter.legalForm?.length) {
    const wanted = filter.legalForm
      .map(normaliseLegalForm)
      .filter((form): form is string => Boolean(form));
    // No form recorded means we cannot say it matches. Excluding is right here:
    // the filter exists to keep sole traders out, and "unknown" is exactly the
    // case where letting it through would defeat that.
    if (!company.legalForm || !wanted.includes(company.legalForm)) return false;
  }

  // Only an explicit "not trading" excludes. An unknown status is kept, since
  // null from `isActiveStatus` means the wording was unrecognised, not that the
  // company is gone.
  if (filter.activeOnly && isActiveStatus(status) === false) return false;

  // `domain` rather than `website`: the raw column holds phone numbers and
  // other junk, and `extractDomain` has already refused to parse those.
  if (filter.hasWebsite && !company.domain) return false;

  return true;
}
