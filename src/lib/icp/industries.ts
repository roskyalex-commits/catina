import { INDUSTRY_DEFINITIONS, type IndustryDefinition } from "./industry-definitions";
import {
  INDUSTRY_NACE_CODES,
  NACE_CONFLICTS,
  NACE_LABELS,
} from "./nace-codes.generated";

/**
 * Industries as the vocabulary, NACE as the derivation.
 *
 * The complaint that started this: the ICP was driven by CAEN codes, which are
 * an industry proxy the trade register happens to publish, not a statement of
 * who buys. But CAEN is also the only thing `companies.caen` is indexed on, so
 * it cannot simply be removed — it stays as the **query axis**, derived from
 * something a person can actually reason about.
 *
 * The other half of the point is that asking a language model for four-digit
 * activity codes was the last unchecked model→SQL path in the product. Nothing
 * downstream validated them, a wrong code silently returned the wrong companies,
 * and "the code for advertising agencies" is unconstrained recall. A choice from
 * 37 named industries is a constrained one, and every code it produces comes
 * from the official nomenclator.
 *
 * ## What stays CAEN
 *
 * `caenCodes` remains on the ICP and remains what the sourcing query filters on.
 * `normaliseIcpIndustries` recomputes it from the chosen industries unless the
 * user has taken it over, in which case `caenCodesOverridden` pins their list
 * and nothing here touches it again. An MVP that already has working CAEN
 * targeting keeps working; it just stops depending on a model's memory.
 */

export type Industry = IndustryDefinition & {
  /** Every CAEN class this industry covers, across every live revision. */
  naceCodes: readonly string[];
};

export const INDUSTRIES: readonly Industry[] = INDUSTRY_DEFINITIONS.map(
  (definition) => ({
    ...definition,
    naceCodes: INDUSTRY_NACE_CODES[definition.key] ?? [],
  }),
);

const BY_KEY = new Map(INDUSTRIES.map((industry) => [industry.key, industry]));

/**
 * Non-empty tuple, because `z.enum` needs one.
 *
 * The cast is safe as long as `INDUSTRY_DEFINITIONS` is non-empty, which
 * `industries.test.ts` asserts rather than assuming.
 */
export const INDUSTRY_KEYS = INDUSTRY_DEFINITIONS.map((d) => d.key) as [
  string,
  ...string[],
];

export { NACE_CONFLICTS, NACE_LABELS };

export function industryByKey(key: string): Industry | undefined {
  return BY_KEY.get(key);
}

/** Romanian label for a code, from the newest revision that defines it. */
export function naceLabel(code: string): string | undefined {
  return NACE_LABELS[code];
}

/* ------------------------------------------------------------- resolution */

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every phrase that resolves to an industry, longest first.
 *
 * Longest-first matters: "software development" must not be beaten by "it"
 * simply because the shorter alias was declared earlier. Sorting once at module
 * load is cheaper than reasoning about declaration order in 37 definitions.
 */
const LOOKUP: { phrase: string; key: string }[] = INDUSTRIES.flatMap((industry) =>
  [industry.key, industry.label, industry.labelRo, ...industry.aliases].map((phrase) => ({
    phrase: fold(phrase),
    key: industry.key,
  })),
)
  .filter((entry) => entry.phrase.length >= 2)
  .sort((a, b) => b.phrase.length - a.phrase.length);

const EXACT = new Map<string, string>();
// Built in reverse so the *shortest* phrase wins a tie on identical text, which
// only happens when two industries declare the same alias — a definition bug
// the test catches rather than something to resolve cleverly here.
for (const entry of [...LOOKUP].reverse()) EXACT.set(entry.phrase, entry.key);

/**
 * Free-text industry → an industry key.
 *
 * Exact match first, then a whole-word containment scan. Containment is
 * deliberately *not* a substring test: "IT" must not match "retail", and
 * "media" must not match "remedial".
 */
export function resolveIndustry(text: string): string | null {
  const folded = fold(text);
  if (folded.length < 2) return null;

  const exact = EXACT.get(folded);
  if (exact) return exact;

  const words = folded.split(" ");
  for (const entry of LOOKUP) {
    const phraseWords = entry.phrase.split(" ");
    if (containsSequence(words, phraseWords)) return entry.key;
  }
  return null;
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    let hit = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** The union of every industry's codes, deduplicated and sorted. */
export function naceCodesFor(keys: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const key of keys) {
    for (const code of BY_KEY.get(key)?.naceCodes ?? []) codes.add(code);
  }
  return [...codes].sort();
}

/**
 * Which industries a code belongs to. Display only.
 *
 * A preview card whose only hard fact about a company is a four-digit code can
 * still show "Software & IT services" next to it. Never use this to build a
 * query — that direction is `naceCodesFor`.
 */
export function industriesForCode(code: string): string[] {
  return INDUSTRIES.filter((industry) => industry.naceCodes.includes(code)).map(
    (industry) => industry.key,
  );
}
