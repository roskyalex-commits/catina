import {
  industriesForCode,
  industryByKey,
  naceCodesFor,
  resolveIndustry,
} from "./industries";
import type { Icp } from "./schema";

/**
 * Turning rejected preview leads into ICP corrections — deterministically.
 *
 * The obvious implementation is to send the five rejected companies to Claude
 * and ask what the ICP got wrong. It is also the wrong one, for three reasons
 * that all bite at the same time: it costs money on every click of a button
 * users are meant to click repeatedly, it adds two seconds to an interaction
 * that should feel instant, and it cannot be tested — the same five rejections
 * produce different advice on different days.
 *
 * What the rules below give up in subtlety they get back in being explainable.
 * Every suggestion carries the count that produced it ("4 of 5 were advertising
 * agencies"), which is what makes it safe to *offer* rather than apply: the
 * user reads the reason and decides. Nothing here ever rewrites an ICP by
 * itself — `applyRefinement` is called by a click, not by this module.
 */

/** Below this many rejections, one bad lead would rewrite the whole ICP. */
const MIN_REJECTIONS = 3;
/** How much of the reject set has to share a trait before it is a pattern. */
const SHARE = 0.6;

export type RejectedLead = {
  companyName: string;
  caen?: string | null;
  employeeCount?: number | null;
};

export type Refinement =
  | {
      kind: "drop_industry";
      industryKey: string;
      /** The codes removing this industry would take with it. */
      codes: string[];
      label: string;
      reason: string;
    }
  | { kind: "add_exclusion"; term: string; label: string; reason: string }
  | {
      kind: "narrow_employees";
      min: number | null;
      max: number | null;
      label: string;
      reason: string;
    };

/**
 * Legal forms and filler that every Romanian company name contains.
 *
 * Without this, "SRL" is shared by 5 of 5 rejections every single time and the
 * exclusion rule fires on every reject set in the country.
 */
const NAME_STOPWORDS = new Set([
  "srl", "sa", "srls", "pfa", "ii", "if", "sca", "snc", "gmbh", "ltd", "llc",
  "inc", "bv", "nv", "sro", "kft", "zrt", "the", "and", "group", "grup",
  "company", "companie", "romania", "international", "consulting", "solutions",
  "services", "servicii", "trading", "prod", "com", "impex", "invest",
]);

function tokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !NAME_STOPWORDS.has(token));
}

export function refineIcpFromRejections(
  icp: Icp,
  rejects: readonly RejectedLead[],
): Refinement[] {
  if (rejects.length < MIN_REJECTIONS) return [];

  const threshold = Math.ceil(rejects.length * SHARE);
  const refinements: Refinement[] = [];

  // --- an industry the user keeps saying no to ----------------------------
  const byIndustry = new Map<string, number>();
  for (const reject of rejects) {
    if (!reject.caen) continue;
    // Counted once per lead even when a code maps to several industries, so a
    // broadly-claimed code cannot outvote a specific one.
    for (const key of new Set(industriesForCode(reject.caen))) {
      byIndustry.set(key, (byIndustry.get(key) ?? 0) + 1);
    }
  }

  for (const [key, count] of [...byIndustry.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < threshold) continue;
    // Only worth offering if it is actually in the ICP — a code can resolve to
    // an industry the user never selected.
    if (!icp.industryKeys.includes(key)) continue;
    if (icp.industryKeys.length <= 1) continue; // dropping the last one targets nothing

    const industry = industryByKey(key);
    refinements.push({
      kind: "drop_industry",
      industryKey: key,
      codes: naceCodesFor([key]),
      label: `Stop targeting ${industry?.label ?? key}`,
      reason: `${count} of ${rejects.length} rejected companies are in it.`,
    });
  }

  // --- a word that keeps showing up in the names --------------------------
  const byToken = new Map<string, number>();
  for (const reject of rejects) {
    for (const token of new Set(tokens(reject.companyName))) {
      byToken.set(token, (byToken.get(token) ?? 0) + 1);
    }
  }

  for (const [token, count] of [...byToken.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < threshold) continue;
    if (icp.exclusions.some((existing) => existing.toLowerCase() === token)) continue;

    refinements.push({
      kind: "add_exclusion",
      term: token,
      label: `Exclude companies with "${token}" in the name`,
      reason: `${count} of ${rejects.length} rejected names contain it.`,
    });
  }

  // --- rejections bunched at one end of the size band ---------------------
  const sized = rejects
    .map((reject) => reject.employeeCount)
    .filter((count): count is number => typeof count === "number" && count > 0);

  if (sized.length >= threshold) {
    const narrowing = narrowBand(icp, sized, rejects.length);
    if (narrowing) refinements.push(narrowing);
  }

  return refinements;
}

/**
 * Move whichever bound the rejections cluster against.
 *
 * Only fires when the rejections sit entirely on one side of the band's
 * midpoint. A spread of sizes means size was not the problem, and inventing a
 * bound from it would narrow the search for no reason.
 */
function narrowBand(
  icp: Icp,
  sizes: number[],
  rejectCount: number,
): Refinement | null {
  const min = icp.employeeMin ?? 0;
  const max = icp.employeeMax;
  if (max === null || max <= min) return null;

  const midpoint = (min + max) / 2;
  const low = sizes.filter((size) => size < midpoint);
  const high = sizes.filter((size) => size >= midpoint);

  if (low.length === sizes.length) {
    const newMin = Math.max(...low) + 1;
    if (newMin <= min || newMin >= max) return null;
    return {
      kind: "narrow_employees",
      min: newMin,
      max,
      label: `Raise the minimum to ${newMin} employees`,
      reason: `All ${low.length} of ${rejectCount} rejections with a headcount were smaller than that.`,
    };
  }

  if (high.length === sizes.length) {
    const newMax = Math.min(...high) - 1;
    if (newMax >= max || newMax <= min) return null;
    return {
      kind: "narrow_employees",
      min: icp.employeeMin,
      max: newMax,
      label: `Lower the maximum to ${newMax} employees`,
      reason: `All ${high.length} of ${rejectCount} rejections with a headcount were larger than that.`,
    };
  }

  return null;
}

/**
 * Applies one accepted suggestion. Pure, and the only writer.
 *
 * Note what dropping an industry does to `caenCodes`: it recomputes them from
 * the industries that remain rather than subtracting the dropped industry's
 * codes. Subtracting would strip a code two industries share, quietly narrowing
 * an industry the user did not touch.
 */
export function applyRefinement(icp: Icp, refinement: Refinement): Icp {
  switch (refinement.kind) {
    case "drop_industry": {
      const industryKeys = icp.industryKeys.filter(
        (key) => key !== refinement.industryKey,
      );
      return {
        ...icp,
        industryKeys,
        /*
         * Resolved, not compared to the label. The free text is whatever the
         * model or the user wrote — "Ecommerce", "online retail", "Comerț
         * online" — and any phrase left behind that still resolves to this key
         * would put the industry straight back on the next normalise pass.
         */
        industries: icp.industries.filter(
          (text) => resolveIndustry(text) !== refinement.industryKey,
        ),
        // Overridden lists stay the user's; they took the codes over on purpose.
        caenCodes: icp.caenCodesOverridden ? icp.caenCodes : naceCodesFor(industryKeys),
      };
    }
    case "add_exclusion":
      return { ...icp, exclusions: [...icp.exclusions, refinement.term] };
    case "narrow_employees":
      return { ...icp, employeeMin: refinement.min, employeeMax: refinement.max };
  }
}
