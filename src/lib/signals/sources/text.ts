/**
 * Diacritic-insensitive whole-word matching over crawled page text.
 *
 * Romanian writes the same word three ways in practice — "factură", "factura"
 * and "facturã" — and a seller typing a keyword into onboarding will pick one
 * of them. Substring matching would paper over that but bring its own problem:
 * "CRM" matching "microcrm", or "erp" matching "superb". So the matching is
 * folded *and* word-bounded.
 *
 * The offset map is the part worth explaining. Folding changes the length of
 * the string — "ă" is one character before NFD and two after — so a match
 * position in the folded text does not point at the same place in the original.
 * Every signal must carry evidence a user can read, and evidence with the
 * diacritics stripped out reads like a bug. Keeping the map costs one array and
 * lets the snippet come back verbatim from the page.
 */

/** Combining marks, which is what NFD turns every Romanian diacritic into. */
const COMBINING_MARKS = /[\u0300-\u036f]/;

export type FoldedText = {
  /** Lower-cased, diacritic-free. Match against this. */
  folded: string;
  /** `source[offsets[i]]` is where `folded[i]` came from. */
  offsets: number[];
  /** The text as it was on the page. Slice evidence out of this. */
  source: string;
};

export function foldText(source: string): FoldedText {
  let folded = "";
  const offsets: number[] = [];

  for (let i = 0; i < source.length; i += 1) {
    // Case is preserved. `keywordPattern` decides case-sensitivity per keyword,
    // and it cannot do that against text that has already been lower-cased.
    const decomposed = source[i].normalize("NFD");
    for (const char of decomposed) {
      if (COMBINING_MARKS.test(char)) continue;
      folded += char;
      // Every character produced by this source character points back at it,
      // so a match that starts mid-decomposition still resolves to a real
      // position in the original.
      offsets.push(i);
    }
  }

  return { folded, offsets, source };
}

/** Diacritics out, case and content otherwise untouched. */
export function stripDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Case-folded too, for comparing short strings by identity. */
export function fold(value: string): string {
  return stripDiacritics(value).toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Longest keyword still treated as an acronym.
 *
 * Short capitalised keywords are matched **case-sensitively**, and the reason is
 * concrete rather than theoretical. The agent running against the live database
 * targets the keyword `IT`, which case-insensitively matches the English word
 * "it" — several times a paragraph on the English-language homepage of every
 * Romanian software company in the register. Every one of them would have
 * scored a keyword signal for nothing, and the signal component would have gone
 * from constant zero to constant noise.
 *
 * Longer keywords stay case-insensitive: "e-Factura" and "e-factura" are the
 * same word, and a seller should not have to guess a site's capitalisation.
 */
const ACRONYM_MAX_LENGTH = 4;

function isAcronym(cleaned: string): boolean {
  return (
    cleaned.length <= ACRONYM_MAX_LENGTH &&
    /[A-Z]/.test(cleaned) &&
    cleaned === cleaned.toUpperCase()
  );
}

/**
 * A whole-word matcher for one keyword.
 *
 * Interior whitespace becomes `\s+` so "magazin online" still matches a page
 * that wrapped the phrase across a line. `\b` is ASCII-only, which is exactly
 * right *after* diacritics are stripped and would be wrong before it.
 */
export function keywordPattern(keyword: string): RegExp | null {
  const cleaned = stripDiacritics(keyword);
  if (cleaned.length < 2) return null;

  const body = escapeRegex(cleaned).replace(/ /g, "\\s+");
  // Guard the edges only where the keyword itself starts or ends with a word
  // character — "c#" or ".net" have no word boundary to anchor to.
  const left = /^\w/.test(cleaned) ? "\\b" : "";
  const right = /\w$/.test(cleaned) ? "\\b" : "";
  return new RegExp(`${left}${body}${right}`, isAcronym(cleaned) ? "g" : "gi");
}

export type TextMatch = {
  /** The keyword as the user typed it, not as it was folded. */
  keyword: string;
  /** ~140 characters of the original page around the hit. */
  snippet: string;
};

const SNIPPET_RADIUS = 60;

/**
 * First occurrence of `keyword` in `text`, with a snippet from the original.
 *
 * Returns the first hit rather than counting every one: a page that says
 * "e-factura" nine times is not nine times more interesting than one that says
 * it once, and the count would just become a knob nobody can calibrate.
 */
export function findKeyword(text: FoldedText, keyword: string): TextMatch | null {
  const pattern = keywordPattern(keyword);
  if (!pattern) return null;

  const match = pattern.exec(text.folded);
  if (!match) return null;

  const startFolded = match.index;
  const endFolded = match.index + match[0].length;
  // The map has one entry per folded character, so the end offset comes from
  // the last matched character rather than one past it.
  const start = text.offsets[startFolded] ?? 0;
  const end = (text.offsets[endFolded - 1] ?? start) + 1;

  const from = Math.max(0, start - SNIPPET_RADIUS);
  const to = Math.min(text.source.length, end + SNIPPET_RADIUS);
  const snippet =
    (from > 0 ? "…" : "") +
    text.source.slice(from, to).replace(/\s+/g, " ").trim() +
    (to < text.source.length ? "…" : "");

  return { keyword, snippet };
}
