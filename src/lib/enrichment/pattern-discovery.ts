import {
  inferDominantPattern,
  inferPatterns,
  isRoleAddress,
  type EmailPattern,
} from "./patterns";
import { classifyToken } from "./romanian-names";

/**
 * Turning a published address into evidence about a company's convention.
 *
 * The waterfall has always had a pattern-inference step and it has never once
 * fired, because `knownContacts` — a confirmed name/address pair at the domain
 * — was never supplied by any caller. This is what supplies it.
 *
 * ## Why this does not parse HTML
 *
 * The obvious approach to "whose address is `andrei.pop@firma.ro`" is to find
 * the name printed next to it on the page. That means parsing wildly variable
 * markup, and it fails in exactly the case that matters: a `mailto:` in a
 * footer with no name anywhere near it.
 *
 * We do not need to. We already know who works there — ONRC gives us the
 * company's administrators by law. So the question becomes "does this address
 * match anyone we already have", which is a set intersection over people we
 * hold rather than an extraction problem. `inferPatterns` answers it and names
 * the convention in the same call.
 *
 * The pairing is *confirmation*, not inference: `andrei.pop@` matching a person
 * recorded as `Pop Andrei` is proof of both the person and the convention.
 */

/**
 * Patterns that consume both halves of a name.
 *
 * A match on one of these is strong evidence — the odds of `andrei.pop@`
 * lining up with a person called Andrei Pop by accident are negligible. A match
 * on `first` alone is not: `ana@firma.ro` fits every Ana in the country, and
 * pairing it with the one Ana we happen to hold would invent a fact.
 */
const STRONG_PATTERNS: ReadonlySet<EmailPattern> = new Set<EmailPattern>([
  "first.last",
  "firstlast",
  "first_last",
  "first-last",
  "flast",
  "f.last",
  "firstl",
  "last.first",
  "lastfirst",
  "lastf",
]);

export type KnownPerson = {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
};

export type AddressPair = {
  address: string;
  personId: string;
  fullName: string;
  /*
   * The already-resolved halves, carried rather than re-derived.
   *
   * Re-splitting `fullName` downstream is exactly the mistake `romanian-names.ts`
   * exists to prevent: the ONRC display name is surname-first, and any consumer
   * reaching for a generic splitter would silently swap them back.
   */
  firstName: string;
  lastName: string;
  /** Every convention consistent with this pairing, prevalence-ordered. */
  patterns: EmailPattern[];
  /** True when a both-halves pattern matched, rather than a first-name-only one. */
  strong: boolean;
};

/**
 * Match published addresses against the people we already hold at that company.
 *
 * Role addresses are excluded up front: `office@` belongs to the company, and
 * an unlucky company with an administrator called Officiu would otherwise pair
 * with it.
 */
export function pairAddresses(
  addresses: readonly string[],
  people: readonly KnownPerson[],
): AddressPair[] {
  const pairs: AddressPair[] = [];

  for (const address of addresses) {
    if (isRoleAddress(address)) continue;

    const matches: AddressPair[] = [];
    for (const person of people) {
      const patterns = inferPatterns(address, {
        firstName: person.firstName,
        lastName: person.lastName,
      });
      if (patterns.length === 0) continue;

      matches.push({
        address,
        personId: person.id,
        fullName: person.fullName,
        firstName: person.firstName,
        lastName: person.lastName,
        patterns,
        strong: patterns.some((pattern) => STRONG_PATTERNS.has(pattern)),
      });
    }

    const strong = matches.filter((match) => match.strong);
    if (strong.length > 0) {
      /*
       * More than one strong match means two people at the company have names
       * that collapse to the same local part — siblings in a family firm, which
       * Romanian SRLs are full of. Neither can be confirmed, so neither is
       * claimed, but the *convention* is still visible and the caller keeps it.
       */
      if (strong.length === 1) pairs.push(strong[0]);
      else pairs.push({ ...strong[0], personId: "", fullName: "" });
      continue;
    }

    // Weak-only: accept it solely when there is nobody else it could be.
    if (matches.length === 1) pairs.push(matches[0]);
  }

  return pairs;
}

export type CompanyPattern = {
  pattern: EmailPattern;
  confidence: number;
  /** How many confirmed addresses backed it. */
  samples: number;
};

/**
 * The convention a company uses, from its confirmed pairs.
 *
 * Delegates the tally to `inferDominantPattern`, which already handles the
 * ambiguous single sample and weights agreement across several. This adds only
 * the sample count, because a pattern from one address and a pattern from three
 * deserve different treatment downstream and the caller cannot otherwise tell
 * them apart.
 */
export function inferCompanyPattern(
  pairs: readonly AddressPair[],
): CompanyPattern | null {
  if (pairs.length === 0) return null;

  const dominant = inferDominantPattern(
    pairs.map((pair) => ({
      email: pair.address,
      // The resolved halves off the pair, never a fresh split of `fullName`.
      name: { firstName: pair.firstName, lastName: pair.lastName },
    })),
  );
  if (!dominant) return null;

  return { ...dominant, samples: pairs.length };
}


/**
 * Read a convention off the *shape* of an address, without knowing whose it is.
 *
 * ## Why this exists
 *
 * Pairing against known people was the original design and it barely fires.
 * Measured over 200 live Romanian sites: 36.5% published any address at all,
 * 6.5% published a personal one, and **0.5%** produced a confirmed pair. The
 * reason is structural, not a tuning problem — ONRC gives us the company's
 * *administrator*, while the address a company prints on its contact page
 * belongs to whoever answers the phone. They are rarely the same person.
 *
 * But `cristian.petrache@codeunit.ro` still tells us this company writes
 * addresses `first.last`, and it tells us that whether or not Cristian Petrache
 * is anyone we hold. The lexicon built from ~30,000 register names is what
 * makes that readable: `cristian` is a given name in Romania as a matter of
 * measured fact, and `petrache` is not.
 *
 * This is strictly weaker evidence than a confirmed pair — it reads a shape
 * rather than verifying an identity — so it is reported separately and at a
 * lower confidence, and a real pair always wins.
 */

/** Separators a company might put between the two halves of a name. */
const SEPARATORS: { char: string; joined: EmailPattern; reversed: EmailPattern }[] = [
  { char: ".", joined: "first.last", reversed: "last.first" },
  { char: "_", joined: "first_last", reversed: "last.first" },
  { char: "-", joined: "first-last", reversed: "last.first" },
];

export type ShapeReading = { pattern: EmailPattern; confidence: number };

/**
 * The convention an address demonstrates, or null when its shape says nothing.
 *
 * Deliberately conservative. Two lexicon-known halves in a known arrangement is
 * a reading; anything else — one unknown half, a department name, a bare word —
 * is not, because a wrong convention propagates to every other person at the
 * domain and is far more expensive than no convention at all.
 */
export function readPatternFromShape(address: string): ShapeReading | null {
  const local = address.split("@")[0]?.toLowerCase().trim();
  if (!local || isRoleAddress(address)) return null;

  // Trailing digits are a disambiguator a person added, not part of the name.
  const cleaned = local.replace(/[0-9]+$/, "");

  for (const separator of SEPARATORS) {
    const parts = cleaned.split(separator.char);
    if (parts.length !== 2) continue;

    const [left, right] = parts.map(classifyToken);

    if (left === "given" && right === "surname") {
      return { pattern: separator.joined, confidence: 0.7 };
    }
    if (left === "surname" && right === "given") {
      return { pattern: separator.reversed, confidence: 0.7 };
    }
    /*
     * One half known and the other merely unrecognised is still a reading: the
     * lexicon covers common names, not every name, so an unknown surname beside
     * a known given name is the ordinary case rather than a contradiction.
     * Ambiguous on either side is not, since that token is evidence for nothing.
     */
    if (left === "given" && right === "unknown") {
      return { pattern: separator.joined, confidence: 0.55 };
    }
    if (left === "unknown" && right === "given") {
      return { pattern: separator.reversed, confidence: 0.55 };
    }
    return null;
  }

  // `apop@` — a single initial glued to a surname. Unmistakable when the rest
  // of the local part is a name the register knows.
  const initial = /^([a-z])([a-z]{2,})$/.exec(cleaned);
  if (initial && classifyToken(initial[2]) === "surname") {
    return { pattern: "flast", confidence: 0.6 };
  }

  if (classifyToken(cleaned) === "given") {
    return { pattern: "first", confidence: 0.6 };
  }

  return null;
}

/**
 * The best convention available for a domain, pairs first, shapes second.
 *
 * The two sources are not averaged. A confirmed pair is a different kind of
 * fact from a plausible shape, and blending them would produce a number that
 * means neither — so a pair wins outright when there is one, and the shape
 * reading is used only in its absence.
 */
export function bestCompanyPattern(
  pairs: readonly AddressPair[],
  addresses: readonly string[],
): (CompanyPattern & { basis: "paired" | "shape" }) | null {
  const paired = inferCompanyPattern(pairs);
  if (paired) return { ...paired, basis: "paired" };

  const readings = addresses
    .map(readPatternFromShape)
    .filter((reading): reading is ShapeReading => reading !== null);
  if (readings.length === 0) return null;

  const tally = new Map<EmailPattern, ShapeReading[]>();
  for (const reading of readings) {
    tally.set(reading.pattern, [...(tally.get(reading.pattern) ?? []), reading]);
  }

  const [pattern, group] = [...tally].sort((a, b) => b[1].length - a[1].length)[0];
  const best = Math.max(...group.map((reading) => reading.confidence));

  return {
    pattern,
    // Agreement across several addresses at one domain raises it, but never to
    // where a confirmed pair sits — this remains an inference about a shape.
    confidence: Math.min(0.8, best + 0.05 * (group.length - 1)),
    samples: group.length,
    basis: "shape",
  };
}
