/**
 * Joining the ONRC exports.
 *
 * The register is published as separate files that reference each other by the
 * trade-register number (`J12/1234/2020`), not by CUI:
 *
 *   OD_FIRME            the company itself — name, CUI, address, website
 *   OD_STARE_FIRMA      status codes, decoded via N_STARE_FIRMA
 *   OD_CAEN_AUTORIZAT   authorised activity codes, decoded via N_CAEN
 *
 * Everything here is pure so the join rules can be tested without the 690MB
 * file. The streaming and the writing live in scripts/import-onrc.ts.
 */

import { isValidCaen } from "@/lib/sources/caen";

/** Trade-register number, e.g. `J12/1234/2020`. The actual join key. */
export type RegNumber = string;

/**
 * Normalise a trade-register number for joining.
 *
 * The files are not perfectly consistent about spacing or case, and a join that
 * silently misses is worse than one that fails loudly — a company would simply
 * come out with no status and get filtered on a technicality.
 */
export function normaliseRegNumber(raw: string): RegNumber {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/* ------------------------------------------------------------------ status */

/**
 * Status codes that mean the company has stopped trading.
 *
 * From N_STARE_FIRMA. Deliberately a small explicit list rather than "anything
 * that is not 1048": the nomenclature has 198 codes and most are events a live
 * company passes through (capital increase, address change, merger), not deaths.
 */
export const TERMINAL_STATUS_CODES = new Set([
  1049, // dizolvare
  1052, // lichidare
  1070, // faliment
  1084, // radiată
]);

/**
 * Not trading now, though it may resume.
 *
 * Kept separate from the terminal codes because the distinction is real — a
 * suspended company can come back — but for outreach the answer is the same:
 * a business that has halted activity is not evaluating software this quarter.
 */
export const SUSPENDED_STATUS_CODES = new Set([
  1074, // întrerupere temporară de activitate
]);

/** Everything that means "not a prospect today". */
export const NOT_TRADING_STATUS_CODES = new Set([
  ...TERMINAL_STATUS_CODES,
  ...SUSPENDED_STATUS_CODES,
]);

/**
 * The code meaning the company is trading.
 *
 * Note what is deliberately *not* here: 2069 `sediu expirat` and 2120
 * `perioadă de suspendare activitate expirată` are administrative flags, and a
 * live company routinely carries one alongside `funcțiune`. Treating them as
 * deaths would discard a large share of perfectly good prospects.
 */
export const TRADING_STATUS_CODE = 1048; // funcțiune

export type StatusVerdict = {
  /** True = trading, false = struck off or failed, null = cannot tell. */
  trading: boolean | null;
  codes: number[];
};

/**
 * Resolve the several status rows a company may have.
 *
 * OD_STARE_FIRMA carries no date, so there is no "latest" row to prefer — a
 * company can appear more than once and the file does not say in what order.
 * The rule is therefore conservative in the direction that matters: any
 * terminal code wins, because emailing a struck-off company is worse than
 * skipping a live one.
 *
 * Unknown stays null rather than false. Half the register is `radiată`, so if
 * the codes ever change meaning, a silent reclassification would either empty
 * the import or fill it with the dead — both should be visible, not guessed.
 */
export function resolveStatus(codes: number[]): StatusVerdict {
  if (codes.length === 0) return { trading: null, codes };
  if (codes.some((code) => NOT_TRADING_STATUS_CODES.has(code))) {
    return { trading: false, codes };
  }
  if (codes.includes(TRADING_STATUS_CODE)) return { trading: true, codes };
  return { trading: null, codes };
}

/* -------------------------------------------------------------------- caen */

export type CaenEntry = {
  code: string;
  /** N_VERSIUNE_CAEN: 0=1998, 1=2003, 2=2008, 3=2025. */
  version: number;
  /** True when the register marks this as the company's principal activity. */
  principal: boolean;
};

/** The newest CAEN revision in the published nomenclature. */
export const CAEN_VERSION_CURRENT = 3;

/**
 * Pick the one activity code to store on the company.
 *
 * A company authorises many activities — often dozens — but targeting needs a
 * single principal one, and `companies.caen` is a single column. Preference
 * order: the register's own principal flag, then the newest CAEN revision
 * (Romania moved to Rev 3 in 2025 and both still appear), then the lowest code
 * for determinism, so re-importing does not shuffle rows.
 */
export function principalCaen(entries: CaenEntry[]): CaenEntry | undefined {
  const valid = entries.filter((entry) => isValidCaen(entry.code));
  if (valid.length === 0) return undefined;

  const flagged = valid.filter((entry) => entry.principal);
  const pool = flagged.length > 0 ? flagged : valid;

  return [...pool].sort(
    (a, b) =>
      b.version - a.version || a.code.localeCompare(b.code),
  )[0];
}

/**
 * Does any authorised activity match the filter?
 *
 * Companies authorise 4.8 activities on average and OD_CAEN_AUTORIZAT carries
 * no principal-activity flag, so there is no single "real" code to test. Asking
 * whether *any* authorised code matches is both the honest reading of the data
 * and the useful one: a company authorised for 6201 is a software company for
 * targeting purposes, whichever code happens to sort first.
 *
 * Returns the matching entry so the caller can store the code that explains the
 * match rather than an unrelated one.
 */
export function matchingCaen(
  entries: CaenEntry[],
  wanted: string[],
): CaenEntry | undefined {
  if (wanted.length === 0) return undefined;
  const hits = entries.filter(
    (entry) =>
      isValidCaen(entry.code) &&
      wanted.some((code) =>
        code.length === 2 ? entry.code.startsWith(code) : entry.code === code,
      ),
  );
  return principalCaen(hits);
}

/* ------------------------------------------------------- caen nomenclature */

export type CaenNomenclature = Map<string, { label: string; version: number }>;

/** Key for the nomenclature map — a code means different things per version. */
export function caenKey(code: string, version: number): string {
  return `${version}:${code}`;
}

/**
 * Build the code → label table from N_CAEN.CSV rows.
 *
 * Columns: SECTIUNEA, SUBSECTIUNEA, DIVIZIUNEA, GRUPA, CLASA, DENUMIRE,
 * VERSIUNE_CAEN. `CLASA` is the 4-digit code; rows without one are section or
 * division headers and carry no company.
 */
export function buildCaenNomenclature(rows: string[][]): CaenNomenclature {
  const map: CaenNomenclature = new Map();
  for (const row of rows) {
    const [, , , , clasa, denumire, versiune] = row;
    const code = (clasa ?? "").trim();
    if (!isValidCaen(code)) continue;
    const version = Number((versiune ?? "").trim());
    map.set(caenKey(code, Number.isFinite(version) ? version : 0), {
      label: (denumire ?? "").trim(),
      version,
    });
  }
  return map;
}

/** Build the status code → label table from N_STARE_FIRMA.CSV rows. */
export function buildStatusNomenclature(rows: string[][]): Map<number, string> {
  const map = new Map<number, string>();
  for (const [cod, denumire] of rows) {
    const code = Number((cod ?? "").trim());
    if (Number.isFinite(code) && cod?.trim()) {
      map.set(code, (denumire ?? "").trim());
    }
  }
  return map;
}

/**
 * A label for the status, for `companies.onrc_status`.
 *
 * Keeps the register's own wording rather than flattening to a boolean — the
 * reason a company is not trading is worth showing, and `radiată` and
 * `faliment` are not the same news.
 */
export function statusLabel(
  codes: number[],
  nomenclature: Map<number, string>,
): string | undefined {
  const labels = codes
    .map((code) => nomenclature.get(code))
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(", ") : undefined;
}

/* ----------------------------------------------------------------- website */

/**
 * Extract a bare domain from the register's free-text WEB column.
 *
 * The field is typed by hand at registration, so it arrives as `www.x.ro`,
 * `http://x.ro/`, `X.RO`, an email address, or junk. A domain is what makes
 * crawling, tech-stack detection and email-pattern inference possible, so it is
 * worth parsing carefully — but a wrong domain attributes another company's
 * website to this one, so anything doubtful is dropped.
 */
export function extractDomain(raw: string): string | undefined {
  let value = raw.trim().toLowerCase();
  if (!value || value.length > 253) return undefined;

  // A contact email sometimes lands in this column.
  if (value.includes("@")) value = value.split("@").pop() ?? "";

  value = value
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s,;]/)[0]
    .replace(/\.$/, "");

  // Must look like a hostname with a plausible TLD.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(value)) {
    return undefined;
  }
  if (!/\.[a-z]{2,}$/.test(value)) return undefined;

  return value;
}
