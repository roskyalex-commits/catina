import { stripSoleTraderSuffix } from "@/lib/sources/onrc/representatives";
import {
  AMBIGUOUS_NAMES,
  GIVEN_NAMES,
  SURNAMES,
} from "./given-names.generated";

/**
 * Which half of a Romanian name is the surname.
 *
 * This exists because two modules in this codebase disagreed about the same
 * data, silently, for as long as both have existed. `splitFullName` in
 * `patterns.ts` reads a name given-first — right for vendor data and for a team
 * page. ONRC writes surname-first. So `Podar Simona Mihaela`, run through the
 * email generator, produced `podar.mihaela@` where the real address is
 * `simona.podar@`. Nothing caught it because generation had never once run
 * against register data.
 *
 * The register does not label the halves: `OD_REPREZENTANTI_LEGALI` has a
 * single `NUME` column. So the order has to be inferred, and the evidence is
 * the lexicon in `given-names.generated.ts`, derived from the positional
 * statistics of ~30,000 names in that same register.
 *
 * ## The rule this file exists to enforce
 *
 * A name it cannot resolve is **skipped, not guessed**. An unresolvable name
 * costs one contact; a confidently wrong one puts a stranger's name on an email
 * to their employer's domain, and enough of those cost the sending domain its
 * reputation. `MIN_NAME_CONFIDENCE` is the line, and callers must check it.
 */

export type NameOrder = "surname-first" | "given-first" | "auto";

export type ResolvedName = {
  firstName?: string;
  lastName?: string;
  /**
   * Other spellings of the same halves, likeliest first, `firstName` excluded.
   *
   * Compound names are why this exists. `Dan-Alexandru Chiuzbaian` is `dan` to
   * most Romanian companies and `danalexandru` to some, and no amount of
   * inference settles which — only a mailbox check does. Generating both and
   * letting the verifier decide is cheaper and more honest than picking one and
   * calling it confidence.
   */
  firstNameVariants: string[];
  lastNameVariants: string[];
  /** 0-1. Below `MIN_NAME_CONFIDENCE`, do not build an address from this. */
  confidence: number;
  /** Which order was used, for the audit trail on a generated address. */
  order: Exclude<NameOrder, "auto">;
  /** What decided it — `lexicon` is evidence, `convention` is assumption. */
  basis: "lexicon" | "convention" | "unresolved";
};

/**
 * Below this, build no address.
 *
 * 0.6 admits a name resolved from the source's known convention with no lexicon
 * evidence either way, and excludes one where the lexicon actively disagrees
 * with itself. Both halves being unknown tokens is the common case for a
 * foreign name, and convention carries it.
 */
export const MIN_NAME_CONFIDENCE = 0.6;

/**
 * Same folding as `slugifyName` in `patterns.ts`, and as the generator's.
 *
 * All three have to agree or a lexicon entry becomes unfindable — the tokens
 * were folded on the way in, so they must be folded the same way on the way
 * out.
 */
export function foldToken(value: string): string {
  return fold(value);
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[șş]/gi, "s")
    .replace(/[țţ]/gi, "t")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** The order a source is known to write names in. */
export function nameOrderForSource(source: string | null | undefined): NameOrder {
  switch (source) {
    /*
     * The national register, and anything derived from it. Romanian official
     * records are surname-first without exception, including for the Hungarian
     * and German names common in Transylvania — `Tussay Szilard` is surname
     * first for the same reason `Podar Simona` is.
     */
    case "onrc":
    case "anaf":
      return "surname-first";
    /*
     * Everything else is a person or a vendor writing a name the way a person
     * writes it. A team page says "Simona Podar"; so does Hunter.
     */
    case "website":
    case "hunter":
    case "prospeo":
    case "pdl":
    case "apify":
      return "given-first";
    default:
      return "auto";
  }
}

export type NameClass = "given" | "surname" | "ambiguous" | "unknown";

type Class = NameClass;

/**
 * What the register's own statistics say about one already-folded token.
 *
 * Exported because the lexicon is useful beyond splitting a name: reading
 * `cristian.petrache@` as `first.last` needs exactly this question answered
 * about `cristian`, and the answer must come from the same table or the two
 * would drift.
 */
export function classifyToken(token: string): NameClass {
  return classify(token);
}

function classify(token: string): Class {
  // Ambiguous is checked first: a token in both lists is exactly the case the
  // generator carved out, and it must not be read as evidence either way.
  if (AMBIGUOUS_NAMES.has(token)) return "ambiguous";
  if (GIVEN_NAMES.has(token)) return "given";
  if (SURNAMES.has(token)) return "surname";
  return "unknown";
}

const UNRESOLVED: ResolvedName = {
  firstNameVariants: [],
  lastNameVariants: [],
  confidence: 0,
  order: "given-first",
  basis: "unresolved",
};

/**
 * One word of a name, and the pieces a hyphen splits it into.
 *
 * `parts` is what the lexicon is consulted with, because the generator splits
 * hyphens too. `compound` is the whole word folded, kept because it is a real
 * spelling of the same name and some companies use it.
 */
type Word = { parts: string[]; compound: string };

function toWords(fullName: string): Word[] {
  return stripSoleTraderSuffix(fullName)
    .split(/\s+/)
    .map((word) => ({
      parts: word
        .split(/[-‐‑–—]/)
        .map(fold)
        .filter((part) => part.length > 1),
      compound: fold(word),
    }))
    /*
     * Drops patronymic initials — `Chertes L Liviu` is Liviu Chertes, and the
     * middle `L` is the father's given name abbreviated. Romanian records carry
     * it often. It is never part of an address.
     */
    .filter((word) => word.parts.length > 0 && word.compound.length > 1);
}

/**
 * Classify a word by its strongest piece.
 *
 * The compound is checked first because a genuinely single name wins outright;
 * then the pieces, so `Pop-Visan` is recognised as a surname on the strength of
 * `pop`. A word is only ambiguous when nothing in it is decisive.
 */
function classifyWord(word: Word): Class {
  const direct = classify(word.compound);
  if (direct !== "unknown") return direct;

  const classes = word.parts.map(classify);
  if (classes.includes("given") && !classes.includes("surname")) return "given";
  if (classes.includes("surname") && !classes.includes("given")) return "surname";
  if (classes.includes("ambiguous")) return "ambiguous";
  return "unknown";
}

/**
 * Split a full name into the parts an email address is built from.
 *
 * `order` is the caller's knowledge of the source, used only when the lexicon
 * has nothing to say. Lexicon evidence always wins over it: a `website` source
 * that happens to print "Popescu Ion" still resolves correctly.
 */
export function resolveNameParts(
  fullName: string,
  options: { order?: NameOrder } = {},
): ResolvedName {
  const hint = options.order ?? "auto";

  let words = toWords(fullName);

  if (words.length === 0) return UNRESOLVED;

  /*
   * A whole name typed with hyphens instead of spaces — `Bota-Cristian-Lucian`
   * is Cristian Bota, keyed that way by whoever filed it. Two rows in the
   * current register look like this. Treating the pieces as separate words
   * recovers them; without it the name resolves to one token and is skipped.
   *
   * Only when there is a single word: `Pop-Vișan Mihai-Adrian` already has two,
   * and splitting there would turn a double-barrelled surname into two names.
   */
  if (words.length === 1 && words[0].parts.length >= 2) {
    words = words[0].parts.map((part) => ({ parts: [part], compound: part }));
  }

  if (words.length === 1) {
    // One usable word cannot yield both halves. Returned rather than dropped
    // because `first`-pattern domains exist, but at a confidence that keeps it
    // below the threshold on its own.
    return {
      firstName: words[0].parts[0],
      firstNameVariants: variantsOf(words[0], "given").slice(1),
      lastNameVariants: [],
      confidence: 0.3,
      order: hint === "surname-first" ? "surname-first" : "given-first",
      basis: "unresolved",
    };
  }

  const first = classifyWord(words[0]);
  const last = classifyWord(words[words.length - 1]);

  /*
   * Score each reading by how much of it the lexicon supports. A name is
   * surname-first if it opens with a surname or closes with a given name, and
   * given-first for the mirror image. Both ends agreeing is the strong case;
   * one end is weaker but still evidence; a tie means the lexicon knows nothing
   * useful and the source's convention decides.
   */
  const surnameFirstScore =
    (first === "surname" ? 1 : 0) + (last === "given" ? 1 : 0);
  const givenFirstScore =
    (first === "given" ? 1 : 0) + (last === "surname" ? 1 : 0);

  let order: Exclude<NameOrder, "auto">;
  let confidence: number;
  let basis: ResolvedName["basis"];

  if (surnameFirstScore !== givenFirstScore) {
    order = surnameFirstScore > givenFirstScore ? "surname-first" : "given-first";
    const margin = Math.abs(surnameFirstScore - givenFirstScore);
    // Both ends pointing the same way is near-certain; one end is good enough
    // to send on, but the difference is worth keeping in the audit trail.
    confidence = margin >= 2 ? 0.95 : 0.8;
    basis = "lexicon";
  } else if (hint !== "auto") {
    order = hint;
    confidence = 0.6;
    basis = "convention";
  } else {
    /*
     * No lexicon evidence and no known source. Returned with parts filled in on
     * the more common convention so a caller that wants to display something
     * can, but below the threshold, so nothing builds an address from it.
     */
    order = "given-first";
    confidence = 0.3;
    basis = "unresolved";
  }

  return { ...extract(words, order), confidence, order, basis };
}

/**
 * Spellings of one word, likeliest first.
 *
 * The two halves of a name break the opposite way, which is why this takes a
 * side. A compound *given* name leads with its first element, because that is
 * the name the person goes by — `Dan-Alexandru` signs off as Dan. A compound
 * *surname* leads with the whole thing, because that is the legal surname and
 * dropping half of it renames the person.
 *
 * A word with no hyphen has one spelling either way and produces one entry.
 */
function variantsOf(word: Word, side: "given" | "surname"): string[] {
  const ordered =
    side === "given"
      ? [...word.parts, word.compound]
      : [word.compound, ...word.parts];
  return [...new Set(ordered)];
}

/**
 * Pull the two halves out once the order is settled.
 *
 * Middle words are second given names — `Podar Simona Mihaela` is Simona, not
 * Simona Mihaela — so the given name taken is the first one the lexicon
 * recognises, falling back to the word adjacent to the surname.
 */
function extract(
  words: Word[],
  order: Exclude<NameOrder, "auto">,
): Pick<ResolvedName, "firstName" | "lastName" | "firstNameVariants" | "lastNameVariants"> {
  const surname = order === "surname-first" ? words[0] : words[words.length - 1];
  const rest = order === "surname-first" ? words.slice(1) : words.slice(0, -1);
  const given = rest.find((word) => classifyWord(word) === "given") ?? rest[0];

  const firstNameVariants = variantsOf(given, "given");
  const lastNameVariants = variantsOf(surname, "surname");

  return {
    firstName: firstNameVariants[0],
    lastName: lastNameVariants[0],
    firstNameVariants: firstNameVariants.slice(1),
    lastNameVariants: lastNameVariants.slice(1),
  };
}

/**
 * The resolver every caller holding a `people` row should use.
 *
 * Exists so that "which order does this source write in" is answered in one
 * place rather than at each call site — the mistake this whole file corrects
 * was exactly that question being answered implicitly, by whichever splitter
 * happened to be imported.
 */
export function resolvePersonName(person: {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  source?: string | null;
}): ResolvedName {
  /*
   * Trust already-split columns. `backfill-names.ts` writes them from this same
   * function, and a vendor that returned the halves separately never needed
   * inference at all.
   */
  if (person.firstName && person.lastName) {
    return {
      firstName: fold(person.firstName),
      lastName: fold(person.lastName),
      // No variants: the halves are already settled, so there is nothing left
      // to be uncertain about. Whatever produced them resolved the compound.
      firstNameVariants: [],
      lastNameVariants: [],
      confidence: 0.95,
      order: "given-first",
      basis: "lexicon",
    };
  }

  return resolveNameParts(person.fullName, {
    order: nameOrderForSource(person.source),
  });
}
