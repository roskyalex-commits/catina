import { z } from "zod";
import { foldDiacritics, nameTokens } from "./domain-guess";

/**
 * Finding a company's website by asking a search engine.
 *
 * Guessing domains from company names is measured dead — 0 of 55 on the live
 * run — and the reason is structural rather than fixable: a Romanian company's
 * legal name is frequently not its brand. BASICSOFT SRL trades as codespring.ro
 * and ACDM DIGITAL ONE as thebrightsession.com. No amount of string
 * manipulation recovers that association, because the association does not
 * exist in the string.
 *
 * A search engine, however, already knows it — that is precisely what a search
 * index is. So candidates come from search here, and are then put through the
 * verifier that was always the sound half of the old approach: a Romanian
 * company must publish its fiscal code on its own website, so finding that
 * exact number on a page is proof of ownership.
 *
 * The hard part is not the API. It is that **searching a Romanian company name
 * returns company-registry aggregators, not the company** — listafirme.ro,
 * termene.ro, risco.ro and a dozen others exist to rank for exactly this query,
 * and they will all mention the CUI, so they would sail through the verifier.
 * `AGGREGATOR_DOMAINS` below is the part that makes this work at all.
 *
 * Everything here is pure except `BraveSearch.search`.
 */

/**
 * Sites that publish other companies' registry data.
 *
 * These rank first for "<company name> CUI" by design, and every one of them
 * displays the fiscal code — so the CUI verifier, which is otherwise proof of
 * ownership, waves them straight through. Excluding them is not a quality
 * filter, it is the difference between this working and returning
 * `listafirme.ro` for all 11,597 companies.
 */
export const AGGREGATOR_DOMAINS = new Set([
  // Romanian registry aggregators
  "listafirme.ro", "termene.ro", "risco.ro", "confidas.ro", "firme.info",
  "mfinante.gov.ro", "mfinante.ro", "openapi.ro", "topfirme.com",
  "romanian-companies.eu", "companiidinromania.ro", "infocui.ro",
  "datefirme.ro", "bilanturi.ro", "portal.onrc.ro", "onrc.ro", "anaf.ro",
  "static.anaf.ro", "recom.onrc.ro", "doingbusiness.ro", "clasamentefirme.ro",
  "verificatfirme.ro", "codfiscal.net", "romanianfirms.com",
  // Observed in live results, and each is a sibling of one already listed:
  // aggregators run the same database under several TLDs.
  "listafirme.eu", "lege5.ro", "companywall.ro", "rolist.ro", "bizoo.ro",
  // Directories, marketplaces and social — a profile is not a website
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "pinterest.com", "wikipedia.org",
  "google.com", "maps.google.com", "yelp.com", "foursquare.com",
  "mapquest.com", "waze.com", "tripadvisor.com", "bing.com",
  "paginiaurii.ro", "pagini-aurii.ro", "cylex.ro", "tuugo.ro", "hotfrog.ro",
  "europages.ro", "europages.co.uk", "kompass.com", "yellowpages.ro",
  "olx.ro", "publi24.ro", "emag.ro", "ejobs.ro", "bestjobs.eu",
  "indeed.com", "glassdoor.com", "crunchbase.com", "zoominfo.com",
  "dnb.com", "opencorporates.com", "bizprofile.net", "northdata.com",
]);

/** Is this host one of the aggregators, or a subdomain of one? */
export function isAggregator(host: string): boolean {
  const bare = host.toLowerCase().replace(/^www\./, "");
  if (AGGREGATOR_DOMAINS.has(bare)) return true;
  return [...AGGREGATOR_DOMAINS].some((known) => bare.endsWith(`.${known}`));
}

export type SearchResult = {
  url: string;
  title: string;
  description: string;
};

/**
 * Search queries for one company, best first.
 *
 * Three shapes, because they fail in different ways and the free tier is 2,000
 * queries a month — enough to spend two on a company, not twenty.
 *
 *   1. name + CUI       — most precise, but ranks aggregators highest because
 *                         they are the sites that publish fiscal codes
 *   2. name + county     — closer to how a person searches for a business
 *   3. name + "contact"  — biases toward the company's own contact page
 *
 * The CUI query is still worth running first: aggregators are filtered out by
 * host, and what remains after that filter is unusually likely to be the real
 * site, since few others mention both the trading name and the fiscal code.
 */
export function searchQueries(company: {
  name: string;
  county?: string | null;
  cui?: string | null;
}): string[] {
  const tokens = nameTokens(company.name);
  if (tokens.length === 0) return [];

  // The legal form is noise to a search engine and pulls in the registry
  // aggregators, which index by exact legal name.
  const trading = foldDiacritics(tokens.join(" "));
  const queries = [`"${trading}" ${company.cui ?? ""}`.trim()];

  if (company.county) queries.push(`"${trading}" ${company.county} site oficial`);
  queries.push(`"${trading}" contact romania`);

  return queries;
}

export type DomainCandidate = {
  domain: string;
  /** Where in the result list it appeared — earlier is better. */
  rank: number;
  /** The result that produced it, so a wrong candidate is explainable. */
  title: string;
  /**
   * How it was found. `result` is the host of a result we would visit;
   * `cited` is a domain named *inside* an aggregator's title or snippet.
   */
  via: "result" | "cited";
};

/**
 * TLDs a bare, scheme-less host is allowed to have.
 *
 * Snippet text is prose, and prose is full of things shaped like hostnames.
 * Requiring a plausible TLD keeps "CIF17459688" and "J12/1330/2005" out
 * without needing to understand Romanian.
 */
const CITED_TLDS = [
  "ro", "com", "eu", "net", "org", "io", "dev", "tech", "agency", "online",
  "app", "co", "biz", "info", "digital", "solutions", "group", "media",
];

/**
 * Domains named inside a result's own text.
 *
 * This is the step that makes search work for Romanian companies, and it was
 * measured rather than designed. Searching BASICSOFT SRL returns listafirme.ro
 * first, and its result title is literally
 * `Website BASICSOFT SRL din Cluj Napoca https://codespring.ro` — the
 * aggregator we must exclude as a *destination* is the thing publishing the
 * answer. Without this, the same search yields `basicsoft.us` (an unrelated
 * American company) and nothing else.
 */
export function citedDomains(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  /*
   * Markup is stripped two ways, and both are needed.
   *
   * Brave highlights the query terms, so a snippet arrives as
   * `<strong>codespring</strong>.ro` — replacing a tag with a space splits
   * that host in half. Replacing it with nothing fixes that case and breaks
   * the other one, fusing `…text</p><p>domain.ro…` into a hostname nobody
   * wrote. Scanning both readings costs one regex and every candidate faces
   * the CUI check regardless, so a spurious extra candidate costs a fetch,
   * not a wrong answer.
   */
  const readings = [text.replace(/<[^>]*>/g, ""), text.replace(/<[^>]*>/g, " ")];
  for (const cleaned of readings) collect(cleaned, found);

  return [...found];
}

function collect(cleaned: string, found: Set<string>): void {

  const withScheme = cleaned.match(/https?:\/\/[^\s"'<>)\]]+/gi) ?? [];
  for (const raw of withScheme) {
    try {
      found.add(new URL(raw).hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      /* prose that only looks like a URL */
    }
  }

  const bare = cleaned.match(/\b(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi) ?? [];
  for (const raw of bare) {
    const host = raw.toLowerCase().replace(/^www\./, "");
    const tld = host.split(".").pop() ?? "";
    // A bare host needs a plausible TLD; a schemed one has already proved
    // itself by parsing as a URL.
    if (CITED_TLDS.includes(tld)) found.add(host);
  }
}

/**
 * Candidate domains from a page of results, best first and deduplicated.
 *
 * Rank is carried through rather than discarded: search ordering is real
 * information, and a candidate at position one that fails the CUI check is a
 * different signal from one at position nine.
 */
export function candidatesFromResults(
  results: SearchResult[],
  limit = 5,
): DomainCandidate[] {
  const seen = new Set<string>();
  const candidates: DomainCandidate[] = [];

  const offer = (
    domain: string,
    rank: number,
    title: string,
    via: DomainCandidate["via"],
  ) => {
    if (isAggregator(domain)) return;
    // A bare TLD, an IP or a fragment of prose is not a company website.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return;
    if (seen.has(domain)) return;
    seen.add(domain);
    candidates.push({ domain, rank, title, via });
  };

  /*
   * Cited domains first, and deliberately.
   *
   * A domain a registry aggregator names as the company's website is a direct
   * statement about *this* company. A domain that merely ranks for the name is
   * a guess with better provenance than our own — and for BASICSOFT SRL those
   * two produce codespring.ro and basicsoft.us respectively, only one of which
   * is in Romania. Both still face the CUI check; this only decides which is
   * fetched first, and the free tier makes fetch order matter.
   */
  for (const [rank, result] of results.entries()) {
    for (const domain of citedDomains(`${result.title} ${result.description}`)) {
      offer(domain, rank, result.title, "cited");
    }
  }

  for (const [rank, result] of results.entries()) {
    try {
      offer(
        new URL(result.url).hostname.toLowerCase().replace(/^www\./, ""),
        rank,
        result.title,
        "result",
      );
    } catch {
      /* a result whose URL does not parse */
    }
  }

  return candidates.slice(0, limit);
}

const braveSchema = z
  .object({
    web: z
      .object({
        results: z
          .array(
            z
              .object({
                url: z.string().optional(),
                title: z.string().optional(),
                description: z.string().optional(),
              })
              .loose(),
          )
          .default([]),
      })
      .loose()
      .optional(),
  })
  .loose();

export interface WebSearch {
  readonly key: string;
  isConfigured(): boolean;
  search(query: string): Promise<SearchResult[]>;
}

/**
 * Brave Search.
 *
 * Chosen over the alternatives on licensing rather than quality: Brave's free
 * tier permits commercial use and returns an independent index, Google's
 * Custom Search JSON API is 100 queries/day and is not a general web search,
 * and Bing's free tier was retired. 2,000 queries a month at one per second.
 *
 * Written from documentation and **never run against the live API** — the same
 * caveat as every other third-party client here. `probe()` is what to run
 * first; it prints the raw payload rather than asserting a shape.
 */
export class BraveSearch implements WebSearch {
  readonly key = "brave";
  private static readonly BASE = "https://api.search.brave.com/res/v1/web/search";

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");

    const url = new URL(BraveSearch.BASE);
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    /*
     * No `country`. Brave's country enum has 37 entries and **Romania is not
     * one of them** — passing `RO` is a 422, not a soft fallback, so it fails
     * the whole request. Observed, not read: the error body enumerates the
     * accepted values and RO is absent. `search_lang` is a separate parameter
     * and does accept `ro`.
     */
    url.searchParams.set("search_lang", "ro");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 429) {
      throw new Error("Brave rate limit reached — the free tier allows 1 query/second");
    }
    if (!response.ok) {
      throw new Error(`Brave search failed: ${response.status} ${response.statusText}`);
    }

    const parsed = braveSchema.safeParse(await response.json());
    if (!parsed.success) return [];

    return (parsed.data.web?.results ?? [])
      .filter((result): result is { url: string } & typeof result =>
        typeof result.url === "string",
      )
      .map((result) => ({
        url: result.url,
        title: result.title ?? "",
        description: result.description ?? "",
      }));
  }

  /** One live call, printing what actually came back. Run this before trusting anything above. */
  async probe(): Promise<{ configured: boolean; ok: boolean; sample?: unknown; error?: string }> {
    if (!this.apiKey) return { configured: false, ok: false, error: "no key" };
    try {
      const results = await this.search('"codespring" cluj');
      return { configured: true, ok: results.length > 0, sample: results.slice(0, 3) };
    } catch (error) {
      return {
        configured: true,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
