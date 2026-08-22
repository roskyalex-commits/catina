/**
 * One vocabulary for `companies.legal_form`, because two sources fill it.
 *
 * ONRC's `FORMA_JURIDICA` writes abbreviations — `SRL`, `SA`, `PFA`. ANAF
 * writes the full legal name — `SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ`.
 * They mean the same thing and neither is wrong; putting both in one column
 * without reconciling them is what breaks.
 *
 * That is not hypothetical. The column was added, filtered on and tested with
 * ONRC's codes; ANAF enrichment then ran over 309,598 companies and
 * `legal_form = 'SRL'` fell from **291,272 to 31,976** while 260,815 rows
 * quietly said `SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ` instead. Nothing
 * errored. The filter simply stopped finding companies it had found an hour
 * earlier — the same shape as "CAEN is four registers wearing one column" in
 * docs/STATUS.md, arrived at from the other direction.
 *
 * Everything that writes this column goes through `canonicalLegalForm`.
 */

/**
 * ANAF's long names, folded, mapped to ONRC's code.
 *
 * Keys are the output of `fold` below, so diacritics and punctuation do not
 * have to be reproduced exactly here.
 */
const LONG_NAMES: Record<string, string> = {
  "societate comerciala cu raspundere limitata": "SRL",
  "societate cu raspundere limitata": "SRL",
  "societate comerciala pe actiuni": "SA",
  "societate pe actiuni": "SA",
  "societate comerciala in nume colectiv": "SNC",
  "societate in nume colectiv": "SNC",
  "societate comerciala in comandita simpla": "SCS",
  "societate in comandita simpla": "SCS",
  "societate comerciala in comandita pe actiuni": "SCA",
  "societate europeana": "SE",
  "persoana fizica autorizata": "PFA",
  "intreprindere individuala": "II",
  "intreprindere individuala(sau ii)": "II",
  "intreprindere familiala": "IF",
  "asociatie familiala": "IF",
  "regie autonoma": "RA",
  "organizatie cooperatista mestesugareasca": "OCM",
  "organizatie cooperatista de consum": "OCC",
  "institut national de cercetare dezvoltare": "INCD",
};

/**
 * Values that carry no information and must not be stored.
 *
 * `ALTE FORME JURIDICE` is ANAF's "something else" bucket and `N/A` is its
 * "unknown" — writing either would make an absent value look like a recorded
 * one, and `--legal-form` excludes unknowns for a reason.
 */
const MEANINGLESS = new Set(["alte forme juridice", "alt", "n/a", "na", "-"]);

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șşŞȘ]/g, "s")
    .replace(/[țţŢȚ]/g, "t")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The canonical code for a legal form, or undefined when there is not one.
 *
 * Undefined for blank, for ANAF's "other" and "N/A" buckets, and for anything
 * unrecognised that does not already look like a code. Returning the raw string
 * in that last case is deliberate: an unmapped abbreviation is more useful
 * stored than dropped, but an unmapped *sentence* is a mapping gap and storing
 * it would rebuild the problem this file exists to fix.
 */
export function canonicalLegalForm(
  raw: string | null | undefined,
): string | undefined {
  if (!raw?.trim()) return undefined;

  const folded = fold(raw);
  if (MEANINGLESS.has(folded)) return undefined;

  const mapped = LONG_NAMES[folded];
  if (mapped) return mapped;

  // Already a code: letters, digits and hyphens, short. `SRL`, `SRL-D`, `II`.
  const code = raw.replace(/\./g, "").trim().toUpperCase();
  if (/^[A-Z][A-Z0-9-]{0,7}$/.test(code)) return code;

  // A phrase we do not know. Left absent rather than stored, so it shows up as
  // a gap to fix rather than as a value that silently matches nothing.
  return undefined;
}

/** Every code this build can produce. Useful for a filter's error message. */
export const KNOWN_LEGAL_FORMS: readonly string[] = [
  ...new Set(Object.values(LONG_NAMES)),
].sort();
