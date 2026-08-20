import { describe, expect, it } from "vitest";
import { candidateHosts, hostOf, registrable, topicQueries } from "./keyword-search";

describe("topicQueries", () => {
  it("quotes the keyword and never uses a TLD-only site operator", () => {
    // Measured: Brave returns zero results for `site:.ro`. The country filter
    // has to happen on our side, in candidateHosts.
    for (const query of topicQueries("e-factura")) {
      expect(query).toContain('"e-factura"');
      expect(query).not.toContain("site:.ro");
    }
  });

  it("adds a city shape only when a city is given", () => {
    expect(topicQueries("ERP")).toHaveLength(3);
    expect(topicQueries("ERP", "Cluj")).toHaveLength(4);
  });
});

describe("host extraction", () => {
  it("drops www and lower-cases", () => {
    expect(hostOf("https://WWW.Exemplu.RO/despre")).toBe("exemplu.ro");
  });

  it("returns null rather than throwing on junk", () => {
    expect(hostOf("not a url")).toBeNull();
  });

  it("collapses a subdomain onto its registrable domain", () => {
    // blog.acme.ro and acme.ro are one company, and counting them as two
    // discoveries would inflate every number this spike produces.
    expect(registrable("blog.acme.ro")).toBe("acme.ro");
    expect(registrable("acme.ro")).toBe("acme.ro");
  });

  it("keeps the third label for a two-part .ro suffix", () => {
    expect(registrable("shop.acme.com.ro")).toBe("acme.com.ro");
  });
});

describe("candidateHosts", () => {
  it("drops aggregators and de-duplicates", () => {
    const hosts = candidateHosts([
      { url: "https://acme.ro/", title: "", description: "" },
      { url: "https://blog.acme.ro/post", title: "", description: "" },
      { url: "https://www.listafirme.ro/acme-srl", title: "", description: "" },
      { url: "https://linkedin.com/company/acme", title: "", description: "" },
    ]);

    // The directories are the majority of every Romanian search result, and
    // none of them is a prospect.
    expect(hosts).toEqual(["acme.ro"]);
  });

  it("drops hosts outside the target TLD", () => {
    // A Romanian-language query still returns Spanish and US invoicing vendors,
    // and none of them is in a Romanian trade register.
    const hosts = candidateHosts([
      { url: "https://groupseres.com/e-factura", title: "", description: "" },
      { url: "https://alfasign.ro/ghid", title: "", description: "" },
    ]);
    expect(hosts).toEqual(["alfasign.ro"]);
  });
});
