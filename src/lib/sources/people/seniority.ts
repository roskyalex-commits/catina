import type { Seniority } from "@/lib/icp/schema";

/**
 * Maps a free-text job title onto a seniority bucket.
 *
 * Providers return whatever the person wrote on LinkedIn, so this has to cope
 * with English and Romanian in the same list — "Director General" is a CEO,
 * not a director, and getting that wrong would push the single most valuable
 * Romanian buyer persona into the wrong bucket.
 *
 * Order matters: the first matching rule wins, so more specific patterns come
 * before the general ones they would otherwise be swallowed by.
 */

const RULES: { seniority: Seniority; pattern: RegExp }[] = [
  // Founders and owners first — "founding engineer" is an IC, so anchor on
  // the noun rather than the stem.
  {
    seniority: "founder",
    pattern:
      /\b(founder|co-?founder|owner|proprietor|fondator|cofondator|proprietar|asociat|actionar|acționar)\b/i,
  },

  // VP must be tested before C-level: "Vice President" contains a word-bounded
  // "president", so the C-level rule would otherwise swallow every VP.
  {
    seniority: "vp",
    pattern: /\b(vp|v\.p\.|vice[\s-]?president|svp|evp|avp|vicepre[sș]edinte)\b/i,
  },

  // Romanian "Director General" / "Administrator" are the CEO equivalents and
  // must be caught before the generic "director" rule below.
  {
    seniority: "c_level",
    pattern:
      /\b(ceo|cto|cfo|cmo|coo|cio|ciso|cpo|cro|chief\s+\w+(\s+\w+)?\s+officer|managing\s+director|president|director\s+general|administrator|director\s+executiv)\b/i,
  },

  {
    seniority: "head",
    pattern: /\b(head\s+of|global\s+head|group\s+head|[șs]ef(ul)?\s+(de|departament))\b/i,
  },

  // Generic director last among the leadership rules, so the Romanian
  // CEO-equivalents above claim their titles first.
  {
    seniority: "director",
    pattern: /\b(director|directoare|dir\.)\b/i,
  },

  {
    seniority: "manager",
    pattern:
      /\b(manager|management|supervisor|team\s+lead|teamlead|tech\s+lead|lead\b|coordonator|responsabil)\b/i,
  },

  {
    seniority: "individual_contributor",
    pattern:
      /\b(engineer|developer|programator|designer|analyst|analist|specialist|consultant|associate|assistant|asistent|intern|officer|representative|reprezentant|agent|contabil|economist|technician|tehnician)\b/i,
  },
];

export function classifySeniority(title: string | undefined): Seniority | undefined {
  if (!title?.trim()) return undefined;
  const normalised = stripDiacritics(title);
  for (const rule of RULES) {
    if (rule.pattern.test(normalised) || rule.pattern.test(title)) {
      return rule.seniority;
    }
  }
  return undefined;
}

/**
 * Romanian titles are written with and without diacritics interchangeably
 * ("Șef Departament" / "Sef Departament"), so match against both forms.
 */
function stripDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t");
}

/** How well a person matches the ICP, 0-1. Drives the spike's coverage metric. */
export function scoreTitleMatch(
  title: string | undefined,
  icp: { targetTitles: string[]; targetSeniorities: Seniority[] },
): number {
  if (!title?.trim()) return 0;

  const haystack = stripDiacritics(title).toLowerCase();

  // An explicit title match is the strongest signal available.
  for (const target of icp.targetTitles) {
    const needle = stripDiacritics(target).toLowerCase().trim();
    if (!needle) continue;
    if (haystack === needle) return 1;
    if (haystack.includes(needle) || needle.includes(haystack)) return 0.85;
  }

  // Otherwise fall back to the seniority bucket, which generalises across
  // the many ways the same role gets written.
  const seniority = classifySeniority(title);
  if (seniority && icp.targetSeniorities.includes(seniority)) return 0.6;

  return 0;
}

/** True when a person is worth counting as coverage for the ICP. */
export function isDecisionMaker(
  title: string | undefined,
  icp: { targetTitles: string[]; targetSeniorities: Seniority[] },
): boolean {
  return scoreTitleMatch(title, icp) >= 0.6;
}
