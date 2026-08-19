import { describe, expect, it } from "vitest";
import {
  candidatesFromResults,
  citedDomains,
  isAggregator,
  searchQueries,
  type SearchResult,
} from "./domain-search";

/**
 * The whole risk of this approach is one failure mode: a Romanian company-data
 * aggregator ranking above the company itself.
 *
 * They exist to rank for exactly the query we are about to run, and every one
 * of them publishes the fiscal code — so the CUI verifier, which is otherwise
 * proof of ownership, would confirm listafirme.ro as the website of all 11,597
 * companies. These tests are mostly about that.
 */

function result(url: string, title = "x", description = ""): SearchResult {
  return { url, title, description };
}

describe("isAggregator", () => {
  it.each([
    "listafirme.ro",
    "www.termene.ro",
    "risco.ro",
    "mfinante.gov.ro",
    "listafirme.eu",
    "lege5.ro",
    "linkedin.com",
    "paginiaurii.ro",
  ])("recognises %s", (host) => {
    expect(isAggregator(host)).toBe(true);
  });

  it("catches subdomains of an aggregator", () => {
    expect(isAggregator("date.listafirme.ro")).toBe(true);
    expect(isAggregator("ro.linkedin.com")).toBe(true);
  });

  it("does not catch a company whose name merely ends similarly", () => {
    // Substring matching would kill "notlistafirme.ro" and, worse, anything
    // ending in a known name without the dot boundary.
    expect(isAggregator("notlistafirme.ro")).toBe(false);
    expect(isAggregator("codespring.ro")).toBe(false);
  });
});

describe("searchQueries", () => {
  it("searches the trading name, not the legal one", () => {
    // "SRL" pulls in the registry aggregators, which index by exact legal name.
    const [first] = searchQueries({ name: "BASICSOFT S.R.L.", cui: "21457545" });
    expect(first).toContain("basicsoft");
    expect(first).not.toMatch(/s\.r\.l|srl/i);
  });

  it("puts the CUI in the first query", () => {
    const [first] = searchQueries({ name: "BASICSOFT SRL", cui: "21457545" });
    expect(first).toContain("21457545");
  });

  it("folds diacritics, because the index and the register disagree about them", () => {
    const [first] = searchQueries({ name: "ȘTEFĂNESCU CONSTRUCT SRL", cui: "1" });
    expect(first).toContain("stefanescu");
  });

  it("still produces queries with no CUI and no county", () => {
    const queries = searchQueries({ name: "TECHNOPILOT SRL" });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.trim().length > 0)).toBe(true);
  });

  it("returns nothing for a name that is only a legal form", () => {
    expect(searchQueries({ name: "SRL" })).toEqual([]);
  });

  it("stays within a handful of queries — the free tier is 2,000 a month", () => {
    expect(
      searchQueries({ name: "ALPHA BETA SRL", county: "Cluj", cui: "1" }).length,
    ).toBeLessThanOrEqual(3);
  });
});

describe("citedDomains", () => {
  it("finds the website an aggregator names in its own title", () => {
    // Verbatim from a live Brave result for BASICSOFT SRL. This one string is
    // why search works for Romanian companies at all.
    expect(
      citedDomains("Website BASICSOFT SRL din Cluj Napoca https://codespring.ro"),
    ).toContain("codespring.ro");
  });

  it("finds one written without a scheme", () => {
    expect(citedDomains("Vizitati www.codespring.ro pentru detalii")).toContain(
      "codespring.ro",
    );
  });

  it("does not mistake registry identifiers for hostnames", () => {
    // "CIF17459688" and "J12/1330/2005" are in every aggregator snippet.
    const found = citedDomains("Despre Basicsoft Srl CIF17459688 J12/1330/2005 CLUJ");
    expect(found).toEqual([]);
  });

  it("ignores prose that merely contains a dot", () => {
    expect(citedDomains("Afli adresa, telefon, email, cifra de afaceri, etc")).toEqual(
      [],
    );
  });

  it("strips markup, because Brave highlights the query terms", () => {
    expect(citedDomains("<strong>codespring</strong>.ro este site-ul")).toContain(
      "codespring.ro",
    );
  });
});

describe("candidatesFromResults", () => {
  it("drops the aggregators and keeps the company", () => {
    const candidates = candidatesFromResults([
      result("https://www.listafirme.ro/basicsoft-srl-21457545/"),
      result("https://termene.ro/firma/21457545"),
      result("https://codespring.ro/despre-noi"),
    ]);

    expect(candidates.map((c) => c.domain)).toEqual(["codespring.ro"]);
  });

  it("prefers a domain an aggregator cites over one that merely ranks", () => {
    // The real shape of a live result set. basicsoft.us is an unrelated
    // American company that outranks the Romanian one on its own name; the
    // aggregator we exclude as a destination is the thing naming the answer.
    const candidates = candidatesFromResults([
      result("https://basicsoft.us/", "BasicSoft - Business Software That Works"),
      result(
        "https://www.listafirme.ro/basicsoft-srl-17459688/",
        "Website BASICSOFT SRL din Cluj Napoca https://codespring.ro",
      ),
    ]);

    expect(candidates[0]).toMatchObject({ domain: "codespring.ro", via: "cited" });
    expect(candidates[1]).toMatchObject({ domain: "basicsoft.us", via: "result" });
  });

  it("mines the description as well as the title", () => {
    const candidates = candidatesFromResults([
      result("https://termene.ro/firma/x", "TECHNOPILOT SRL", "Site web: technopilot.dev"),
    ]);
    expect(candidates.map((c) => c.domain)).toContain("technopilot.dev");
  });

  it("keeps the search ordering, which is real information", () => {
    const candidates = candidatesFromResults([
      result("https://listafirme.ro/x"),
      result("https://codespring.ro/"),
      result("https://another.ro/"),
    ]);

    // Rank is the position in the original results, not after filtering: a
    // candidate that Brave put third is weaker evidence than one it put first.
    expect(candidates[0]).toMatchObject({ domain: "codespring.ro", rank: 1 });
    expect(candidates[1]).toMatchObject({ domain: "another.ro", rank: 2 });
  });

  it("collapses many pages of one site into one candidate", () => {
    const candidates = candidatesFromResults([
      result("https://codespring.ro/"),
      result("https://www.codespring.ro/cariere"),
      result("https://codespring.ro/contact"),
    ]);

    expect(candidates).toHaveLength(1);
  });

  it("ignores a malformed URL rather than throwing", () => {
    const candidates = candidatesFromResults([
      result("not a url"),
      result("https://codespring.ro/"),
    ]);

    expect(candidates.map((c) => c.domain)).toEqual(["codespring.ro"]);
  });

  it("rejects a bare host with no dot", () => {
    expect(candidatesFromResults([result("http://localhost/")])).toEqual([]);
  });

  it("respects the limit, because each candidate costs a page fetch to verify", () => {
    const many = Array.from({ length: 10 }, (_, i) => result(`https://site${i}.ro/`));
    expect(candidatesFromResults(many, 3)).toHaveLength(3);
  });
});
