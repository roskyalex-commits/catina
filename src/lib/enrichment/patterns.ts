/**
 * Email pattern inference.
 *
 * The free backbone of the waterfall. Once a single confirmed address at a
 * domain is known, the company's naming convention is known, and every other
 * employee's address follows from their name at zero cost. That is what makes
 * a paid enrichment vendor optional rather than load-bearing.
 *
 * Romanian names need specific handling: diacritics never survive into email
 * addresses (Ștefănescu becomes stefanescu), and compound surnames are common.
 */

export type EmailPattern =
  | "first.last"
  | "firstlast"
  | "first_last"
  | "first-last"
  | "flast"
  | "f.last"
  | "firstl"
  | "first"
  | "last"
  | "last.first"
  | "lastfirst"
  | "lastf";

/**
 * Ordered by how common each is *in this market*, measured — not assumed.
 *
 * This list used to be the global folk ordering, and the first three entries
 * are the only ones that matter: `generateCandidates` caps a blind guess at
 * three, so anything below position three is never generated and the companies
 * using it cannot be reached by guessing at all.
 *
 * The old order led with `first.last, flast, firstlast`. Measured over 169
 * Romanian domains with a confirmed convention (`npm run measure:patterns`):
 *
 *   first.last  57%     flast        4%     last         3%
 *   first       28%     first_last   3%     f.last       2%
 *   last.first   4%     lastfirst    1%     firstlast    0%
 *
 * So `firstlast` occupied a generated slot while matching nothing, and `first`
 * — more than a quarter of the market — sat at position four and was never
 * tried. That is 28.2% of domains unreachable, which is not a tuning loss but
 * a hole in coverage.
 *
 * `first` being this common is the genuinely local finding: Romanian SMBs use a
 * bare given name far more than the global convention suggests.
 *
 * Re-run the measurement before changing this. The first three earn their place
 * by evidence.
 */
export const PATTERNS_BY_PREVALENCE: EmailPattern[] = [
  "first.last",
  "first",
  "last.first",
  "flast",
  "first_last",
  "last",
  "f.last",
  "lastfirst",
  // Below here: no observations in the Romanian sample. Ordered by the global
  // convention, since nothing local contradicts it yet.
  "firstlast",
  "firstl",
  "first-last",
  "lastf",
];

export type NameParts = { firstName?: string; lastName?: string };

/**
 * Reduces a name to what can legally appear in the local part of an address:
 * unaccented lowercase ASCII letters. Romanian ș/ț/ă/î/â all fold to their
 * base letter, which is how Romanian companies actually spell addresses.
 */
export function slugifyName(value: string | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Comma-separated forms ("Pop, Ana") and the Romanian comma-below
    // characters that NFD does not decompose.
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/**
 * Splits a display name into parts.
 *
 * Romanian records frequently carry a middle name or a two-part surname
 * ("Ana Maria Popescu Ionescu"). Taking the first token as the given name and
 * the *last* as the surname is right far more often than trying to guess where
 * a compound surname begins.
 */
export function splitFullName(fullName: string): NameParts {
  const tokens = fullName
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    // Drop honorifics and suffixes that would otherwise be read as names.
    .filter((t) => !/^(dr|ing|ec|jr|sr|iii?|phd|mba)\.?$/i.test(t));

  if (tokens.length === 0) return {};
  if (tokens.length === 1) return { firstName: tokens[0] };
  return { firstName: tokens[0], lastName: tokens[tokens.length - 1] };
}

/** Builds the local part for one pattern, or null when parts are missing. */
export function buildLocalPart(
  pattern: EmailPattern,
  parts: NameParts,
): string | null {
  const first = slugifyName(parts.firstName);
  const last = slugifyName(parts.lastName);

  const needsBoth = pattern !== "first" && pattern !== "last";
  if (needsBoth && (!first || !last)) return null;
  if (pattern === "first" && !first) return null;
  if (pattern === "last" && !last) return null;

  switch (pattern) {
    case "first.last":
      return `${first}.${last}`;
    case "firstlast":
      return `${first}${last}`;
    case "first_last":
      return `${first}_${last}`;
    case "first-last":
      return `${first}-${last}`;
    case "flast":
      return `${first[0]}${last}`;
    case "f.last":
      return `${first[0]}.${last}`;
    case "firstl":
      return `${first}${last[0]}`;
    case "first":
      return first;
    case "last":
      return last;
    case "last.first":
      return `${last}.${first}`;
    case "lastfirst":
      return `${last}${first}`;
    case "lastf":
      return `${last}${first[0]}`;
  }
}

/**
 * Infers the company's convention from an address whose owner is known.
 *
 * Returns every pattern consistent with the sample, because some are genuinely
 * ambiguous — "ana@x.ro" for Ana Pop matches both `first` and, if her surname
 * were "Ana", `last`. Callers should prefer the first result but keep the rest
 * as fallbacks.
 */
export function inferPatterns(email: string, parts: NameParts): EmailPattern[] {
  const localPart = email.split("@")[0]?.toLowerCase().trim();
  if (!localPart) return [];

  return PATTERNS_BY_PREVALENCE.filter(
    (pattern) => buildLocalPart(pattern, parts) === localPart,
  );
}

/**
 * Infers the dominant pattern across several known addresses at one domain.
 *
 * More reliable than a single sample: one person may have a legacy address,
 * but three people rarely share the same exception.
 */
export function inferDominantPattern(
  samples: { email: string; name: NameParts }[],
): { pattern: EmailPattern; confidence: number } | null {
  const tally = new Map<EmailPattern, number>();

  for (const sample of samples) {
    for (const pattern of inferPatterns(sample.email, sample.name)) {
      tally.set(pattern, (tally.get(pattern) ?? 0) + 1);
    }
  }
  if (tally.size === 0) return null;

  const ranked = [...tally.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    // Tie-break on prevalence so an ambiguous single sample resolves to the
    // convention that is more common in the wild.
    return (
      PATTERNS_BY_PREVALENCE.indexOf(a[0]) - PATTERNS_BY_PREVALENCE.indexOf(b[0])
    );
  });

  const [pattern, hits] = ranked[0];
  const usableSamples = samples.filter((s) => inferPatterns(s.email, s.name).length > 0);

  return {
    pattern,
    // Agreement across samples, scaled by how many samples there were: one
    // matching sample is suggestive, three is close to certain.
    confidence: Math.min(
      0.95,
      (hits / Math.max(usableSamples.length, 1)) * (0.55 + 0.15 * Math.min(hits, 3)),
    ),
  };
}

export type EmailCandidate = {
  address: string;
  pattern: EmailPattern;
  /** 0-1 before any MX or SMTP check. */
  confidence: number;
};

/**
 * Generates candidate addresses for a person at a domain.
 *
 * With a known pattern, returns that address first at high confidence. Without
 * one, returns the common patterns in prevalence order at low confidence —
 * these are guesses, and the caller must not treat them as verified.
 */
export function generateCandidates(
  fullName: string,
  domain: string,
  options: {
    knownPattern?: EmailPattern;
    patternConfidence?: number;
    max?: number;
    /**
     * Already-resolved halves, overriding the split of `fullName`.
     *
     * Load-bearing for register data. `splitFullName` reads a name
     * given-first, which is right for a vendor and wrong for ONRC — see
     * `romanian-names.ts`. A caller holding a `people` row has the halves
     * resolved correctly already and must pass them here rather than let them
     * be re-derived from a display name that is in the other order.
     */
    parts?: NameParts;
  } = {},
): EmailCandidate[] {
  const parts = options.parts ?? splitFullName(fullName);
  if (!parts.firstName) return [];

  const cleanDomain = domain.trim().toLowerCase().replace(/^www\./, "");
  if (!cleanDomain.includes(".")) return [];

  const max = options.max ?? 5;
  const ordered = options.knownPattern
    ? [
        options.knownPattern,
        ...PATTERNS_BY_PREVALENCE.filter((p) => p !== options.knownPattern),
      ]
    : PATTERNS_BY_PREVALENCE;

  const candidates: EmailCandidate[] = [];
  const seen = new Set<string>();

  for (const pattern of ordered) {
    const localPart = buildLocalPart(pattern, parts);
    if (!localPart) continue;

    const address = `${localPart}@${cleanDomain}`;
    if (seen.has(address)) continue;
    seen.add(address);

    const isKnown = pattern === options.knownPattern;
    candidates.push({
      address,
      pattern,
      confidence: isKnown
        ? (options.patternConfidence ?? 0.8)
        : // Unverified guesses stay well below anything a send should rely on.
          Math.max(0.1, 0.35 - candidates.length * 0.05),
    });

    if (candidates.length >= max) break;
  }

  return candidates;
}

const ROLE_PREFIXES = new Set([
  "office", "contact", "info", "hello", "sales", "vanzari", "marketing",
  "support", "suport", "hr", "cariere", "jobs", "secretariat", "comenzi",
  "admin", "team", "help", "billing", "facturare", "noreply", "no-reply",
]);

/** Role addresses are the only ones defensible for Romanian outreach. */
export function isRoleAddress(email: string): boolean {
  const localPart = email.split("@")[0]?.toLowerCase().split("+")[0] ?? "";
  return ROLE_PREFIXES.has(localPart);
}

/** Conservative syntax check — deliberately not a full RFC 5322 parser. */
export function isPlausibleEmail(email: string): boolean {
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(email.trim());
}
