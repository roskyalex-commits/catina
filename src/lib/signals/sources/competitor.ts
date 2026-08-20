import type { Signal, SignalScanContext, SignalSource } from "../types";
import { fetchSiteSnapshot, SiteFetchError, type SiteSnapshot } from "@/lib/crawl/fetch-site";
import { findKeyword, fold, foldText } from "./text";

/**
 * Competitor signals — "they already pay someone for this".
 *
 * The distinction that makes this worth its own file: `TechStackSignalSource`
 * fires on *change* and therefore cannot produce anything until a company has
 * been scanned twice. **Presence needs no previous scan at all.** "This
 * prospect runs HubSpot today" is the strongest displacement signal available
 * without a paid social API, it is true on the first pass, and it costs nothing
 * beyond the page the scan already fetched.
 *
 * It is also the closest honest equivalent to what Gojiberry calls "companies
 * and competitors engagement" — with the difference that every claim here links
 * to the markup it was read from.
 */

/** Fingerprinted competitor tech is a fact; a name in prose is an inference. */
const TECH_STRENGTH = 0.85;
const MENTION_STRENGTH = 0.5;

export class CompetitorTechSignalSource implements SignalSource {
  readonly key = "competitor_tech";
  readonly label = "Uses a competing product";
  readonly description =
    "Detects competitors you name running on a prospect's site today. Needs no " +
    "previous scan — a company that already pays for the category is the " +
    "shortest path to a sale.";

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.domain) && (context.competitorTech?.length ?? 0) > 0;
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const wanted = context.competitorTech ?? [];
    if (wanted.length === 0) return [];

    const snapshot = await siteFor(context);
    if (!snapshot) return [];

    // Both sides are compared folded: the ICP stores whatever the picker put
    // there, and `TECH_MARKERS` keys are display strings ("Google Analytics").
    const detected = new Set(snapshot.techStack.map(fold));
    const found = wanted.filter((tech) => detected.has(fold(tech)));
    if (found.length === 0) return [];

    return [
      {
        type: "competitor_tech",
        title: `Runs ${found.join(", ")} today`,
        evidenceUrl: snapshot.origin,
        // One competing product is already decisive; a second does not make the
        // conversation twice as likely, so this does not scale with the count.
        strength: TECH_STRENGTH,
        detectedAt: new Date(),
        dedupeKey: `competitor_tech:${snapshot.domain}:${[...found].sort().join(",")}`,
        payload: { competitors: found, detected: snapshot.techStack },
      },
    ];
  }
}

/**
 * A competitor named in a prospect's own copy.
 *
 * The weaker half of the pair, for competitors with no detectable marker — a
 * consultancy, an agency, a local SaaS that ships no recognisable script.
 *
 * Scored at 0.5 rather than higher because the *reason* for the mention is
 * genuinely ambiguous: a customer, a reseller, a partner and a rival all put
 * the same name on the same page. The snippet is what resolves it, which is why
 * this source would be indefensible without one.
 */
export class CompetitorMentionSignalSource implements SignalSource {
  readonly key = "competitor_mention";
  readonly label = "Mentions a competitor";
  readonly description =
    "Finds competitors named in a prospect's own copy, for the ones that ship " +
    "no detectable script. Weaker than a fingerprint — the snippet tells you why.";

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.domain) && (context.competitorNames?.length ?? 0) > 0;
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const names = (context.competitorNames ?? []).filter((n) => fold(n).length >= 3);
    if (names.length === 0) return [];

    const snapshot = await siteFor(context);
    if (!snapshot) return [];

    // A company that shares a word with a competitor would otherwise match
    // itself on every page of its own site.
    const ownTokens = new Set(
      fold(context.company.name ?? "")
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3),
    );
    const candidates = names.filter((name) => !ownTokens.has(fold(name)));
    if (candidates.length === 0) return [];

    const hits: { competitor: string; snippet: string; url: string }[] = [];
    const seen = new Set<string>();

    for (const page of snapshot.pages) {
      const folded = foldText(page.text);
      for (const name of candidates) {
        if (seen.has(name)) continue;
        const match = findKeyword(folded, name);
        if (!match) continue;
        seen.add(name);
        hits.push({ competitor: name, snippet: match.snippet, url: page.url });
      }
    }

    if (hits.length === 0) return [];
    const found = hits.map((hit) => hit.competitor);

    return [
      {
        type: "competitor_mention",
        title: `Names ${found.join(", ")} on their site`,
        evidenceUrl: hits[0].url,
        strength: MENTION_STRENGTH,
        detectedAt: new Date(),
        dedupeKey: `competitor_mention:${snapshot.domain}:${[...found].sort().join(",")}`,
        payload: { competitors: found, hits },
      },
    ];
  }
}

/** See the identical note in `sources/keywords.ts`. */
async function siteFor(context: SignalScanContext): Promise<SiteSnapshot | null> {
  if (context.site) return context.site();
  const domain = context.company.domain;
  if (!domain) return null;
  try {
    return await fetchSiteSnapshot(domain);
  } catch (error) {
    if (error instanceof SiteFetchError) return null;
    throw error;
  }
}
