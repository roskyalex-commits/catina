import type { Signal, SignalScanContext, SignalSource } from "../types";

/**
 * Funding and expansion news, via Google News RSS.
 *
 * Free, no API key, no quota — Google News exposes any search as an RSS feed.
 * That makes it the cheapest way to catch the classic "they just raised" and
 * "they're opening a new site" triggers, and it works for Romanian-language
 * coverage as readily as English.
 *
 * The hard part is precision, not fetching: a naive company-name query returns
 * a lot of noise for companies with common names. Matching is therefore
 * deliberately strict, and a headline that doesn't clearly concern this
 * company is dropped rather than scored low.
 */

const RSS_BASE = "https://news.google.com/rss/search";
const TIMEOUT_MS = 10_000;
const MAX_AGE_DAYS = 90;

/** Romanian and English keywords, since RO coverage is mostly in Romanian. */
const FUNDING_TERMS = [
  "funding", "raised", "investment", "seed round", "series a", "series b",
  "venture", "acquires", "acquisition",
  "finantare", "finanțare", "investitie", "investiție", "runda", "rundă",
  "atras", "capital", "achizitie", "achiziție", "preluare",
];

const EXPANSION_TERMS = [
  "expansion", "expands", "opens", "new office", "new factory", "hiring",
  "launches", "partnership",
  "extindere", "extinde", "deschide", "fabrica", "fabrică", "birou nou",
  "lanseaza", "lansează", "parteneriat", "angajeaza", "angajează",
];

export class NewsSignalSource implements SignalSource {
  readonly key = "news";
  readonly label = "Funding and expansion news";
  readonly description =
    "Watches Google News for funding rounds, acquisitions and expansion — in " +
    "Romanian and English. Free, no API key.";

  constructor(private readonly language: "ro" | "en" = "ro") {}

  isApplicable(context: SignalScanContext): boolean {
    // A one-word generic name produces unusable noise; require something
    // distinctive enough to search for.
    const name = context.company.name?.trim() ?? "";
    return name.length >= 4;
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const name = context.company.name?.trim();
    if (!name) return [];

    const items = await this.fetchFeed(name);
    const signals: Signal[] = [];
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;

    for (const item of items) {
      if (item.publishedAt.getTime() < cutoff) continue;
      // Precision over recall: an unmatched headline is dropped, not scored
      // low, because a wrong signal in outreach copy is worse than none.
      if (!mentionsCompany(item.title, name)) continue;

      const category = categorise(item.title);
      if (!category) continue;

      signals.push({
        type: category === "funding" ? "funding_news" : "expansion_news",
        title: item.title,
        evidenceUrl: item.link,
        strength: category === "funding" ? 0.9 : 0.6,
        detectedAt: item.publishedAt,
        // Keyed on the article, so a rescan updates rather than duplicates.
        dedupeKey: `news:${category}:${item.guid ?? item.link}`,
        payload: { source: item.source, publishedAt: item.publishedAt.toISOString() },
      });
    }

    // One of each kind is enough — five headlines about the same round is
    // noise in the UI, not five reasons to reach out.
    return dedupeByType(signals);
  }

  private async fetchFeed(companyName: string): Promise<NewsItem[]> {
    const terms = [...FUNDING_TERMS.slice(0, 6), ...EXPANSION_TERMS.slice(0, 6)];
    const query = `"${companyName}" (${terms.join(" OR ")})`;
    const locale =
      this.language === "ro" ? "hl=ro&gl=RO&ceid=RO:ro" : "hl=en&gl=US&ceid=US:en";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(
        `${RSS_BASE}?q=${encodeURIComponent(query)}&${locale}`,
        { signal: controller.signal, headers: { accept: "application/rss+xml" } },
      );
      if (!response.ok) return [];
      return parseRssItems(await response.text());
    } catch {
      // News is a bonus source; a fetch failure must not fail the whole scan.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

export type NewsItem = {
  title: string;
  link: string;
  publishedAt: Date;
  source?: string;
  guid?: string;
};

/**
 * Minimal RSS reader.
 *
 * Regex rather than an XML parser because Workers has no DOMParser and pulling
 * in a full parser for four fields is not worth the bundle. The shape of
 * Google News RSS is stable and narrow.
 */
export function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

  for (const block of blocks) {
    const title = decodeXml(extractTag(block, "title"));
    const link = decodeXml(extractTag(block, "link"));
    const pubDate = extractTag(block, "pubDate");
    if (!title || !link) continue;

    const publishedAt = pubDate ? new Date(pubDate) : new Date();
    if (Number.isNaN(publishedAt.getTime())) continue;

    items.push({
      title,
      link,
      publishedAt,
      source: decodeXml(extractTag(block, "source")) || undefined,
      guid: decodeXml(extractTag(block, "guid")) || undefined,
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return "";
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Ampersand last, so an already-decoded entity isn't double-decoded.
    .replace(/&amp;/g, "&");
}

/**
 * Requires the company's distinctive words to appear in the headline.
 *
 * Legal-form suffixes (SRL, SA, GmbH) and generic words are stripped first:
 * "Digital SRL" must not match every headline containing "digital".
 */
export function mentionsCompany(headline: string, companyName: string): boolean {
  const normalise = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[șş]/gi, "s")
      .replace(/[țţ]/gi, "t")
      .toLowerCase();

  const stopWords = new Set([
    "srl", "sa", "sra", "pfa", "srls", "gmbh", "ltd", "llc", "inc", "bv", "nv",
    "the", "and", "group", "grup", "company", "companie", "romania",
  ]);

  const tokens = normalise(companyName)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !stopWords.has(t));

  if (tokens.length === 0) return false;

  const haystack = normalise(headline);
  // Every distinctive token must appear — "Banca Transilvania" should not
  // match a headline that only says "Banca".
  return tokens.every((token) => haystack.includes(token));
}

export function categorise(headline: string): "funding" | "expansion" | null {
  const lower = headline
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  const normalisedFunding = FUNDING_TERMS.map(stripDiacritics);
  const normalisedExpansion = EXPANSION_TERMS.map(stripDiacritics);

  // Funding wins ties: "raises funding to expand" is a funding story.
  if (normalisedFunding.some((term) => lower.includes(term))) return "funding";
  if (normalisedExpansion.some((term) => lower.includes(term))) return "expansion";
  return null;
}

function stripDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function dedupeByType(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  const out: Signal[] = [];
  // Newest first, so the survivor of each type is the most recent story.
  for (const signal of [...signals].sort(
    (a, b) => b.detectedAt.getTime() - a.detectedAt.getTime(),
  )) {
    if (seen.has(signal.type)) continue;
    seen.add(signal.type);
    out.push(signal);
  }
  return out;
}
