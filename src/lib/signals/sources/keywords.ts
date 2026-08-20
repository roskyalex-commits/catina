import type { Signal, SignalScanContext, SignalSource } from "../types";
import { fetchSiteSnapshot, SiteFetchError, type SiteSnapshot } from "@/lib/crawl/fetch-site";
import { findKeyword, foldText, type TextMatch } from "./text";
import { mentionsCompany, parseRssItems } from "./news";

/**
 * Keyword signals — the answer to "match buyers on what they need, not on
 * which industry code the trade register filed them under".
 *
 * `KeywordSiteSignalSource` is the most valuable source in this build, and the
 * reason is arithmetic rather than cleverness. Four of the seven original
 * sources fire only on a *diff*, so they need two scans before they can ever
 * produce anything; three of them are third-party lookups that a Romanian SMB
 * usually has no entry in. This one reads a page the scan already fetched, and
 * fires on the first pass for every company with a reachable site.
 */

/**
 * Where on a site a keyword was found, and what that is worth.
 *
 * The crawler fetches at most five pages and only from a fixed candidate list
 * (`CANDIDATE_PATHS` in fetch-site.ts) — home, about, pricing, products,
 * solutions, customers. There is no blog and no careers page, so the taxonomy
 * here describes what is actually reachable, not what a richer crawl might see.
 *
 * Homepage first, deliberately. A company puts on its homepage what it wants
 * to be understood as; a keyword there says the topic is central to them. The
 * same word three clicks down a product catalogue is a side activity.
 */
const PAGE_CLASSES: { key: string; label: string; test: RegExp; strength: number }[] = [
  {
    key: "home",
    label: "homepage",
    // The origin with nothing after it, or with only a trailing slash.
    test: /^https?:\/\/[^/]+\/?$/i,
    strength: 0.65,
  },
  {
    key: "about",
    label: "about page",
    test: /\/(about|about-us|despre|despre-noi)\b/i,
    strength: 0.6,
  },
  {
    key: "customers",
    label: "customers page",
    test: /\/(customers|clienti|case-stud)/i,
    strength: 0.5,
  },
  {
    key: "offering",
    label: "product page",
    test: /\/(pricing|preturi|tarife|products|produse|solutions|solutii|servicii)/i,
    strength: 0.45,
  },
];

const OTHER_PAGE = { key: "other", label: "site", strength: 0.4 };

export function classifyPage(url: string): { key: string; label: string; strength: number } {
  for (const candidate of PAGE_CLASSES) {
    if (candidate.test.test(url)) {
      return { key: candidate.key, label: candidate.label, strength: candidate.strength };
    }
  }
  return OTHER_PAGE;
}

export type KeywordHit = TextMatch & {
  url: string;
  pageClass: string;
  pageLabel: string;
};

/**
 * Every keyword found anywhere on the snapshot, best page first.
 *
 * Exported because `scripts/scan-signals.ts` persists it into
 * `company_scans.keyword_hits`, and because a measurement script wants the raw
 * hits without the signal wrapped around them.
 */
export function keywordHits(snapshot: SiteSnapshot, keywords: string[]): KeywordHit[] {
  const hits: KeywordHit[] = [];
  const seen = new Set<string>();

  // Best pages first, so the first hit recorded for a keyword is the one whose
  // placement matters most and the rest are dropped as duplicates.
  const pages = [...snapshot.pages].sort(
    (a, b) => classifyPage(b.url).strength - classifyPage(a.url).strength,
  );

  for (const page of pages) {
    const folded = foldText(page.text);
    const pageClass = classifyPage(page.url);

    for (const keyword of keywords) {
      if (seen.has(keyword)) continue;
      const match = findKeyword(folded, keyword);
      if (!match) continue;

      seen.add(keyword);
      hits.push({
        ...match,
        url: page.url,
        pageClass: pageClass.key,
        pageLabel: pageClass.label,
      });
    }
  }

  return hits;
}

/** How many keywords beyond the first still add to the score. */
const KEYWORD_BONUS_CAP = 3;
const KEYWORD_BONUS = 0.05;
const MAX_KEYWORD_STRENGTH = 0.85;

export class KeywordSiteSignalSource implements SignalSource {
  readonly key = "keyword_site";
  readonly label = "Keywords on their website";
  readonly description =
    "Matches the topics your buyers care about against what a company actually " +
    "says it does. Fires on the first scan, costs no extra request, and links " +
    "to the sentence it found.";

  isApplicable(context: SignalScanContext): boolean {
    // No previous scan required. That is the whole point of this source.
    return Boolean(context.company.domain) && (context.keywords?.length ?? 0) > 0;
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const keywords = context.keywords ?? [];
    if (keywords.length === 0) return [];

    const snapshot = await siteFor(context);
    if (!snapshot) return [];

    const hits = keywordHits(snapshot, keywords);
    if (hits.length === 0) return [];

    const best = hits[0];
    const bestClass = classifyPage(best.url);
    const bonus = Math.min(hits.length - 1, KEYWORD_BONUS_CAP) * KEYWORD_BONUS;
    const strength = Math.min(bestClass.strength + bonus, MAX_KEYWORD_STRENGTH);

    const matched = hits.map((hit) => hit.keyword);
    const named = matched.slice(0, 3).map((k) => `"${k}"`).join(", ");
    const rest = matched.length > 3 ? ` and ${matched.length - 3} more` : "";

    return [
      {
        type: "keyword_on_site",
        title: `Mentions ${named}${rest} on their ${bestClass.label}`,
        evidenceUrl: best.url,
        strength,
        detectedAt: new Date(),
        /*
         * Keyed on the matched set, not on the ICP's full keyword list. Editing
         * an unmatched keyword out of the agent must not orphan the signal that
         * a matched one produced — and when the *matched* set genuinely changes,
         * a new row is the honest outcome, because it is a different claim.
         */
        dedupeKey: `keyword_site:${snapshot.domain}:${[...matched].sort().join(",")}`,
        payload: { hits, keywords: matched },
      },
    ];
  }
}

/** Keywords the news query will carry. More than this and the URL gets silly. */
const NEWS_KEYWORD_LIMIT = 6;
const NEWS_MAX_AGE_DAYS = 120;
const RSS_BASE = "https://news.google.com/rss/search";
const TIMEOUT_MS = 10_000;

/**
 * The company in the news, on one of the ICP's topics.
 *
 * Weaker and more expensive than the site source — one extra HTTP request per
 * company on top of the one `NewsSignalSource` already makes — so it is worth
 * saying plainly what it buys: coverage that is *about the topic* rather than
 * about funding or expansion. A logistics-software seller wants to know that a
 * retailer was written up for opening a warehouse, and no funding query finds
 * that.
 *
 * The company name stays mandatory in the query. A keyword-only search returns
 * the industry, not the company, and every result would have to be thrown away.
 */
export class KeywordNewsSignalSource implements SignalSource {
  readonly key = "keyword_news";
  readonly label = "Keywords in the news";
  readonly description =
    "Watches Google News for coverage that mentions a company alongside your " +
    "topics — not just funding rounds. Free, no API key.";

  constructor(private readonly language: "ro" | "en" = "ro") {}

  isApplicable(context: SignalScanContext): boolean {
    const name = context.company.name?.trim() ?? "";
    return name.length >= 4 && (context.keywords?.length ?? 0) > 0;
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const name = context.company.name?.trim();
    const keywords = (context.keywords ?? []).slice(0, NEWS_KEYWORD_LIMIT);
    if (!name || keywords.length === 0) return [];

    const items = await this.fetchFeed(name, keywords);
    const cutoff = Date.now() - NEWS_MAX_AGE_DAYS * 86_400_000;

    for (const item of items) {
      if (item.publishedAt.getTime() < cutoff) continue;
      // Google's OR query is a suggestion, not a filter — it returns headlines
      // matching neither the name nor a keyword. Both are re-checked here.
      if (!mentionsCompany(item.title, name)) continue;

      const headline = foldText(item.title);
      const matched = keywords.filter((keyword) => findKeyword(headline, keyword));
      if (matched.length === 0) continue;

      // One is enough: the newest story that satisfies both tests. Five
      // headlines about the same event is noise in the UI, not five reasons.
      return [
        {
          type: "keyword_in_news",
          title: item.title,
          evidenceUrl: item.link,
          strength: 0.55,
          detectedAt: item.publishedAt,
          dedupeKey: `keyword_news:${item.guid ?? item.link}`,
          payload: {
            keywords: matched,
            source: item.source,
            publishedAt: item.publishedAt.toISOString(),
          },
        },
      ];
    }

    return [];
  }

  private async fetchFeed(companyName: string, keywords: string[]) {
    const terms = keywords.map((k) => `"${k}"`).join(" OR ");
    const query = `"${companyName}" (${terms})`;
    const locale =
      this.language === "ro" ? "hl=ro&gl=RO&ceid=RO:ro" : "hl=en&gl=US&ceid=US:en";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${RSS_BASE}?q=${encodeURIComponent(query)}&${locale}`, {
        signal: controller.signal,
        headers: { accept: "application/rss+xml" },
      });
      if (!response.ok) return [];
      const items = parseRssItems(await response.text());
      // Newest first, so the one signal this source emits is the latest story.
      return items.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The scan's shared site read, with a direct fetch as the fallback.
 *
 * Same helper as `sources/website.ts` has, and duplicated for the same reason
 * it is duplicated there: a caller that builds a context by hand — the tests,
 * or anyone running one source — still gets a working source.
 */
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
