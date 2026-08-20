import { isAggregator, type SearchResult } from "./domain-search";

/**
 * Keyword → company discovery, and an honest statement of its ceiling.
 *
 * `domain-search.ts` asks "what is *this* company's website", starting from a
 * name in the trade register. This asks the opposite question — "which
 * companies talk about this topic" — which is what Gojiberry's keyword sourcing
 * does and what CAEN targeting fundamentally cannot.
 *
 * **The ceiling, stated up front.** Cătină sources from a registry. A domain
 * that turns up here and is not already in `companies` has no CUI, no
 * administrator, no revenue filing and no route to a contact — so it is a
 * discovery we cannot act on. The realistic value of this path is therefore
 * *re-ranking the companies we already have a domain for*, not finding new
 * ones, and `scripts/measure-keyword-sourcing.ts` exists to measure which of
 * those two it actually does before anything is wired to it.
 *
 * Google News is deliberately not a second channel here. Its RSS carries the
 * publisher's domain, never the subject company's, so a topic feed returns the
 * outlets writing about a market rather than the businesses in it. Extracting
 * the company would need name recognition over headlines, and matching those
 * names back to the register is the same fuzzy join that measured 0 of 55 in
 * the domain-guessing spike.
 */

/**
 * Query shapes for one keyword.
 *
 * Four shapes rather than one, because a single phrasing measures the phrasing
 * as much as the channel. Each targets a different way a Romanian company
 * writes about what it does — the plain term, the term as a service it offers,
 * the term as a need it has, and the term next to a city.
 */
export function topicQueries(keyword: string, city?: string): string[] {
  const quoted = `"${keyword}"`;
  /*
   * No `site:.ro`. Brave returns **zero results** for a TLD-only site operator
   * — measured, not assumed: `"e-factura" firma site:.ro` came back empty while
   * `"e-factura" firma` returned ten results. The country restriction therefore
   * has to happen on our side, in `candidateHosts`, and the queries carry
   * Romanian words instead so the ranking leans that way by itself.
   *
   * `"despre noi"` and `contact` are doing real work here. A bare topic query
   * returns the *vendors* of that topic and the tax authority's own pages; a
   * page titled "despre noi" is almost always a company describing itself.
   */
  const queries = [
    `${quoted} "despre noi" firma`,
    `${quoted} companie contact romania`,
    `${quoted} servicii clienti`,
  ];
  if (city) queries.push(`${quoted} ${city} firma`);
  return queries;
}

/** Hostname without `www.`, or null for anything unparseable. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Distinct candidate hosts from a page of results.
 *
 * Aggregators are dropped with the same list `domain-search.ts` uses. They are
 * the majority of every Romanian search result — listicles, directories, the
 * register's own mirrors — and none of them is a prospect.
 */
export function candidateHosts(results: SearchResult[], tld = ".ro"): string[] {
  const hosts = new Set<string>();
  for (const result of results) {
    const host = hostOf(result.url);
    if (!host || isAggregator(host)) continue;
    // The country filter Brave's `site:` operator refuses to apply. Without it
    // a Romanian-language query still returns Spanish and US invoicing vendors,
    // none of which are in a Romanian trade register.
    if (tld && !host.endsWith(tld)) continue;
    // Subdomains of a real company site are the same company; blog.acme.ro and
    // acme.ro must not count as two discoveries.
    hosts.add(registrable(host));
  }
  return [...hosts];
}

/**
 * The last two labels, or three for a known two-part public suffix.
 *
 * Not a full public-suffix list, and it does not need to be: the query is
 * restricted to `.ro`, where the only common two-part suffixes are these.
 */
const RO_SECOND_LEVEL = new Set(["com.ro", "org.ro", "co.ro", "info.ro", "nom.ro"]);

export function registrable(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return RO_SECOND_LEVEL.has(lastTwo)
    ? parts.slice(-3).join(".")
    : lastTwo;
}
