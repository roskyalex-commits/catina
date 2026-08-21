/**
 * Deciding whether a LinkedIn profile is the person we asked about.
 *
 * Discovery by name is the only entry point we have — we hold names, not
 * LinkedIn URLs — and names are not unique. "Popescu Ion" returns many people,
 * and accepting the first one puts a stranger's job title, employer and profile
 * URL on a lead. That is worse than finding nobody: a blank field is visibly
 * blank, while a wrong title looks exactly like a right one.
 *
 * So the employer is the disambiguator, and this file is the rule.
 *
 * The comparison is harder than it sounds. The register holds legal names —
 * `BUTAN GRUP SRL`, `A.E.G.-TECH SRL`, `SOCIETATEA NATIONALA DE RADIOCOMUNICATII SA`
 * — and LinkedIn holds whatever the company calls itself: `Butan Grup`,
 * `AEG Tech`, `Radiocom`. Legal form, punctuation and diacritics all differ.
 */

/**
 * Romanian legal forms, and the international ones that appear on LinkedIn.
 *
 * Stripped rather than compared: every Romanian company name ends in one, so
 * leaving them in makes every pair look ~30% similar and floods the match.
 */
const LEGAL_FORMS = new Set([
  "srl",
  "srld",
  "sa",
  "sca",
  "scs",
  "snc",
  "pfa",
  "ii",
  "if",
  "srls",
  "ong",
  "asociatia",
  "fundatia",
  "societatea",
  "companiaa",
  "compania",
  "grup",
  "group",
  "holding",
  "ltd",
  "llc",
  "inc",
  "gmbh",
  "bv",
  "se",
]);

/**
 * Words too common in a company name to identify anything.
 *
 * `SC ROMANIA TRADE SRL` and `SC ROMANIA CONSTRUCT SRL` share two of three
 * tokens and are unrelated companies.
 */
const WEAK_TOKENS = new Set([
  "romania",
  "rom",
  "ro",
  "international",
  "trade",
  "trading",
  "com",
  "prod",
  "impex",
  "invest",
  "consulting",
  "consult",
  "service",
  "services",
  "servicii",
  "solutions",
  "solutii",
  "tech",
  "technologies",
  "systems",
  "sistem",
  "sistems",
  "distribution",
  "distributie",
  "construct",
  "constructii",
  "transport",
  "trans",
  "sc",
]);

/** Fold to comparable tokens: no diacritics, no punctuation, no legal form. */
export function companyTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .filter((token) => !LEGAL_FORMS.has(token))
    // Single letters survive only as part of an acronym, which the join below
    // reconstructs; on their own they match everything.
    .filter((token) => token.length > 1);
}

/**
 * `A.E.G.-TECH` becomes `aeg tech` here and `AEG Tech` on LinkedIn, but
 * `A E G TECH` tokenises to four tokens against two. Joining the single letters
 * back up recovers the acronym so the two spellings meet.
 */
function withAcronym(name: string): string[] {
  const letters = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);

  const acronym = letters.filter((t) => t.length === 1).join("");
  const tokens = companyTokens(name);
  return acronym.length > 1 ? [...tokens, acronym] : tokens;
}

export type CompanyMatch = {
  matched: boolean;
  /** 0-1, for reporting. Not a threshold anyone should tune without measuring. */
  score: number;
  reason: string;
};

/**
 * Is the LinkedIn employer the same company as the registry one?
 *
 * Deliberately strict. The cost of a false positive is a wrong person on a
 * lead; the cost of a false negative is one missing title. Those are not
 * symmetric, so this errs towards saying no.
 */
export function companyMatches(registryName: string, linkedinName: string | undefined): CompanyMatch {
  if (!linkedinName?.trim()) {
    return { matched: false, score: 0, reason: "profile lists no current company" };
  }

  const ours = withAcronym(registryName);
  const theirs = withAcronym(linkedinName);

  if (ours.length === 0 || theirs.length === 0) {
    return { matched: false, score: 0, reason: "nothing distinctive to compare" };
  }

  const theirSet = new Set(theirs);
  const shared = ours.filter((token) => theirSet.has(token));
  const strong = shared.filter((token) => !WEAK_TOKENS.has(token));

  // One distinctive word in common, on a short name, is the ordinary case:
  // `BUTAN GRUP SRL` against `Butan Grup` shares only `butan` once `grup` is
  // stripped as a legal form.
  if (strong.length > 0) {
    const score = shared.length / Math.min(ours.length, theirs.length);
    return {
      matched: true,
      score: Math.min(1, score),
      reason: `shares ${strong.join(", ")}`,
    };
  }

  if (shared.length > 0) {
    return {
      matched: false,
      score: 0.2,
      reason: `only generic words in common (${shared.join(", ")})`,
    };
  }

  return { matched: false, score: 0, reason: "no words in common" };
}
