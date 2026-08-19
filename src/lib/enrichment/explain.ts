import type { WaterfallAttempt } from "./waterfall";

/**
 * Why enrichment came back empty, in words a user can act on.
 *
 * A blank cell and a shrug is the worst possible answer here, because the three
 * common failures need three different responses from the user: no domain on
 * file is a data problem they can fix by adding the website, a domain that
 * accepts no mail means the lead is unreachable at all and should be dropped,
 * and a reachable site with no published address is the case where a vendor
 * credit is actually worth spending.
 *
 * Pure and separate from the component so it can be tested without a browser,
 * and so both the table and the bulk script can say the same thing.
 */
export function explainMiss(result: {
  skipped?: string | null;
  attempts?: WaterfallAttempt[];
}): string {
  if (result.skipped === "no_domain") {
    return "No website on file for this company";
  }
  if (result.skipped === "already_tried") {
    return "Already searched — nothing found last time";
  }

  const attempts = result.attempts ?? [];
  const by = (provider: string) => attempts.find((a) => a.provider === provider);

  const mx = by("mx");
  if (mx?.outcome === "miss") return "This domain accepts no mail";
  if (mx?.outcome === "error") return "Could not check the domain — try again";

  // Everything metered was skipped, so the free steps are all that ran and a
  // key is the missing ingredient rather than a better search.
  const vendors = attempts.filter(
    (a) => !["mx", "crawler", "pattern", "pattern-guess"].includes(a.provider),
  );
  if (vendors.length > 0 && vendors.every((a) => a.outcome === "skipped")) {
    const exhausted = vendors.some((a) => a.detail?.includes("allowance"));
    return exhausted
      ? "Free-tier lookups are used up for this month"
      : "No public address on the site, and no lookup provider is connected";
  }

  return "No address found for this person";
}
