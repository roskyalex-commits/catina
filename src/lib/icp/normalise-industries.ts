import { industryByKey, naceCodesFor, resolveIndustry } from "./industries";
import type { Icp } from "./schema";

/**
 * The single point where industries become CAEN codes.
 *
 * Called at exactly two boundaries — after Claude produces an ICP, and when the
 * wizard posts one back — and **never in the query path**. That is the whole
 * design: if derivation happened at query time, a stored agent and a live query
 * could disagree about what the agent targets, and the only way to find out
 * would be to run it. Deriving at the boundary means the row is the truth.
 *
 * Two rules hold here:
 *
 *   1. **Nothing the user wrote is discarded.** An industry that resolves to no
 *      key stays in `industries` and comes back in `unresolved`, so the wizard
 *      can show it as unmatched rather than have it vanish between screens.
 *   2. **`caenCodesOverridden` is absolute.** Once a user has edited the code
 *      list by hand, no later pass recomputes it. Otherwise the next save would
 *      silently undo a list somebody deliberately narrowed.
 */

/** How many codes the ICP will hold. Matches `icpSchema`'s ceiling. */
const MAX_CAEN_CODES = 60;

export type NormaliseResult = {
  icp: Icp;
  /** Industries the catalogue had no match for. Shown, not swallowed. */
  unresolved: string[];
  /**
   * True when the derived list was cut at the ceiling.
   *
   * Worth surfacing: a user who picks eight broad industries gets a truncated
   * query and no other indication of it.
   */
  truncated: boolean;
};

export function normaliseIcpIndustries(icp: Icp): NormaliseResult {
  const keys: string[] = [];
  const unresolved: string[] = [];

  // Keys already chosen — by the wizard's picker, or by a previous pass — are
  // authoritative and are not re-derived from the free text.
  for (const key of icp.industryKeys) {
    if (industryByKey(key) && !keys.includes(key)) keys.push(key);
  }

  for (const text of icp.industries) {
    const key = resolveIndustry(text);
    if (!key) {
      unresolved.push(text);
      continue;
    }
    if (!keys.includes(key)) keys.push(key);
  }

  if (icp.caenCodesOverridden) {
    return { icp: { ...icp, industryKeys: keys }, unresolved, truncated: false };
  }

  const derived = naceCodesFor(keys);
  return {
    icp: {
      ...icp,
      industryKeys: keys,
      caenCodes: derived.slice(0, MAX_CAEN_CODES),
    },
    unresolved,
    truncated: derived.length > MAX_CAEN_CODES,
  };
}
