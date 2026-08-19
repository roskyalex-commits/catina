/**
 * Finding a company's website when the register does not carry one.
 *
 * About 1% of registered Romanian companies list a website in ONRC, and a
 * domain is what unlocks everything else — email pattern inference, the
 * crawler, tech-stack fingerprinting, pricing-page signals. So the domain is
 * the bottleneck, not a nicety.
 *
 * The approach is guess-then-prove, and it is free:
 *
 *   1. derive candidate domains from the company name
 *   2. discard the ones that do not exist (DNS, already built for MX checks)
 *   3. fetch what remains and look for the company's **CUI** in the page
 *
 * Step 3 is the part that makes this trustworthy rather than a heuristic.
 * Romanian companies are legally required to display their fiscal code on
 * their own website, so finding that exact number is near-proof of ownership —
 * far stronger than "the domain looks like the name", which cheerfully matches
 * a squatter, a competitor or an unrelated firm with a similar name.
 *
 * Everything here is pure. The network lives in scripts/discover-domains.ts.
 */

/** Legal forms and suffixes that are not part of the trading name. */
const LEGAL_FORMS = [
  "srl-d", "srld", "s.r.l.-d", "srl", "s.r.l", "s r l",
  "sa", "s.a", "s a", "sca", "snc", "scs", "sprl", "ipurl",
  "pfa", "p.f.a", "ii", "if", "sc", "s.c",
  "societatea", "societate", "compania", "grup", "group", "holding",
];

/**
 * Words too generic to identify a company.
 *
 * A domain built from these matches thousands of firms, so a page found this
 * way proves nothing even if it resolves.
 */
const GENERIC_WORDS = new Set([
  "com", "impex", "prod", "serv", "service", "services", "trans", "consult",
  "consulting", "invest", "trade", "trading", "expert", "total", "general",
  "international", "romania", "roman", "euro", "best", "top", "new", "star",
  "prime", "plus", "max", "pro", "team", "solutions", "solution", "systems",
  "system", "software", "tech", "digital", "media", "design", "studio",
]);

/** Romanian companies are overwhelmingly on `.ro`; `.com` is the distant second. */
export const TLD_PREFERENCE = ["ro", "com", "eu", "net"] as const;

/** Strip diacritics so "Ștefănescu" and "Stefanescu" produce the same slug. */
export function foldDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șşŞȘ]/g, "s")
    .replace(/[țţŢȚ]/g, "t")
    .replace(/[ăâĂÂ]/g, "a")
    .replace(/[îÎ]/g, "i");
}

/**
 * The company's trading name, with legal forms and noise removed.
 *
 * "S.C. TECHNOPILOT SOFTWARE S.R.L." becomes ["technopilot", "software"].
 */
export function nameTokens(rawName: string): string[] {
  const folded = foldDiacritics(rawName).toLowerCase();
  const cleaned = folded.replace(/[^a-z0-9]+/g, " ").trim();

  const tokens = cleaned.split(" ").filter(Boolean);
  const withoutForms = tokens.filter((token) => !LEGAL_FORMS.includes(token));

  // A name that was *only* a legal form leaves nothing to guess from.
  return withoutForms.filter((token) => token.length > 1);
}

/**
 * Is this name distinctive enough to be worth guessing at?
 *
 * "COM IMPEX SRL" is not: the slug would be `comimpex`, which belongs to
 * hundreds of companies, and any page found there would prove nothing.
 */
export function isGuessable(rawName: string): boolean {
  const tokens = nameTokens(rawName);
  if (tokens.length === 0) return false;

  const distinctive = tokens.filter((token) => !GENERIC_WORDS.has(token));
  if (distinctive.length === 0) return false;

  // A single very short token ("ab") collides with everything.
  const joined = distinctive.join("");
  return joined.length >= 4;
}

export type DomainCandidate = {
  domain: string;
  /** Why this was generated — reported so a wrong guess is explainable. */
  basis: "full" | "distinctive" | "hyphenated";
};

/**
 * Candidate domains for a company, best first.
 *
 * Deliberately few. Each candidate costs a DNS lookup and possibly a page
 * fetch, and the tail of increasingly speculative guesses has a rapidly falling
 * hit rate and a rising chance of matching somebody else's site.
 */
export function candidateDomains(
  rawName: string,
  limit = 6,
): DomainCandidate[] {
  if (!isGuessable(rawName)) return [];

  const tokens = nameTokens(rawName);
  const distinctive = tokens.filter((token) => !GENERIC_WORDS.has(token));

  const stems: { stem: string; basis: DomainCandidate["basis"] }[] = [];
  const push = (stem: string, basis: DomainCandidate["basis"]) => {
    if (stem.length >= 3 && stem.length <= 63 && !stems.some((s) => s.stem === stem)) {
      stems.push({ stem, basis });
    }
  };

  push(tokens.join(""), "full");

  // Dropping generic words can leave a single short word — "TUDOR SOLUTIONS"
  // reduces to "tudor" — which is the same trap as guessing the first word.
  // Only keep the reduced stem when it is still specific.
  const distinctiveStem = distinctive.join("");
  if (
    distinctive.length !== tokens.length &&
    (distinctive.length >= 2 || distinctiveStem.length >= 7)
  ) {
    push(distinctiveStem, "distinctive");
  }
  if (distinctive.length > 1) {
    push(distinctive.join("-"), "hyphenated");
  }

  /*
   * No single-word or initials guesses.
   *
   * Measured, not assumed: taking the first distinctive word produced
   * `all.ro` for ALL BEFORE SRL, `business.com` for Z BUSINESS SRL and
   * `cont.ro` for EXPERT CONT&MRU. Every one of those resolves to a real,
   * unrelated site — and because the page necessarily contains the word the
   * guess was built from, a name check waves it straight through. A short stem
   * is not a weak guess, it is a guess at somebody else's domain.
   */

  const candidates: DomainCandidate[] = [];
  // `.ro` for every stem before any `.com`: a Romanian company on a `.com` is
  // the exception, and trying every TLD for stem one wastes lookups.
  for (const tld of TLD_PREFERENCE) {
    for (const { stem, basis } of stems) {
      if (candidates.length >= limit) return candidates;
      candidates.push({ domain: `${stem}.${tld}`, basis });
    }
  }
  return candidates.slice(0, limit);
}

export type DomainEvidence = {
  /** The company's fiscal code appears in the page. */
  cuiOnPage: boolean;
  /** The distinctive part of the company name appears in the page. */
  nameOnPage: boolean;
  /** The page was reachable at all. */
  reachable: boolean;
};

export type DomainVerdict = {
  accepted: boolean;
  confidence: number;
  reason: string;
};

/**
 * Decide whether a candidate really is this company's website.
 *
 * The CUI is the only evidence strong enough on its own. A name match is
 * suggestive but not sufficient — "technopilot.ro" containing the word
 * "technopilot" tells you almost nothing you did not already assume when you
 * generated the guess — so it is accepted only at low confidence and only when
 * the name is distinctive.
 */
export function verifyDomain(
  evidence: DomainEvidence,
  options: { distinctiveName: boolean },
): DomainVerdict {
  if (!evidence.reachable) {
    return { accepted: false, confidence: 0, reason: "did not respond" };
  }
  if (evidence.cuiOnPage) {
    // Companies are legally required to publish this on their own site, and
    // nobody else has a reason to.
    return { accepted: true, confidence: 0.98, reason: "CUI found on the page" };
  }
  /*
   * A name match alone is never enough.
   *
   * This used to be accepted at 0.55 and it was wrong. The name is what the
   * candidate was *generated* from, so finding it on the page is very close to
   * circular — the first live run accepted 16 domains this way and most were
   * other companies. A wrong domain is worse than none: it poisons the email
   * pattern, the tech-stack fingerprint and every signal derived from them, and
   * nothing downstream would ever suspect it.
   *
   * Recorded, not accepted, so a human can review the near-misses.
   */
  if (evidence.nameOnPage) {
    return {
      accepted: false,
      confidence: options.distinctiveName ? 0.4 : 0.15,
      reason: "name on the page but no CUI — unproven",
    };
  }
  return { accepted: false, confidence: 0.05, reason: "page is not about this company" };
}

/**
 * Does the page contain this CUI?
 *
 * Romanian sites write it many ways — `CUI 12345678`, `RO12345678`,
 * `C.U.I.: 12 345 678`, sometimes inside a footer image's alt text. Digits are
 * compared after stripping everything else, and the match must be on a
 * boundary so 12345678 does not match 912345678.
 */
export function pageMentionsCui(html: string, cui: string): boolean {
  const digits = cui.replace(/\D/g, "");
  if (digits.length < 2) return false;

  // Collapse separators that Romanian sites put inside the number itself.
  const haystack = html.replace(/[\s. -]/g, "");
  const pattern = new RegExp(`(?<!\\d)(ro)?${digits}(?!\\d)`, "i");
  return pattern.test(haystack);
}

/** Does the page mention the company's distinctive name? */
export function pageMentionsName(html: string, rawName: string): boolean {
  const distinctive = nameTokens(rawName).filter(
    (token) => !GENERIC_WORDS.has(token) && token.length >= 4,
  );
  if (distinctive.length === 0) return false;

  const haystack = foldDiacritics(html).toLowerCase();
  // Every distinctive token, not any: "nessus group" matching a page that only
  // says "group" is not a match.
  return distinctive.every((token) => haystack.includes(token));
}
