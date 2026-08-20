import { describe, expect, it } from "vitest";
import type { SiteSnapshot } from "@/lib/crawl/fetch-site";
import type { SignalScanContext } from "../types";
import { KeywordSiteSignalSource, classifyPage, keywordHits } from "./keywords";
import { findKeyword, fold, foldText, keywordPattern } from "./text";

/**
 * Two things are being pinned here, and they are not the same thing.
 *
 * The matcher has to survive Romanian: the same word appears with and without
 * diacritics on the same site, and a seller types one of the spellings. And the
 * source has to fire on a **first** scan, because that is the entire reason it
 * exists — four of the older sources cannot produce anything until a company
 * has been seen twice.
 */

function snapshot(pages: { url: string; text: string }[]): SiteSnapshot {
  return {
    domain: "exemplu.ro",
    origin: "https://exemplu.ro",
    pages: pages.map((p) => ({ ...p, title: "t" })),
    techStack: [],
    roleEmails: [],
    socialLinks: {},
  };
}

function context(overrides: Partial<SignalScanContext> = {}): SignalScanContext {
  return {
    company: { dedupeKey: "cui:1", name: "EXEMPLU SRL", domain: "exemplu.ro", source: "onrc" },
    keywords: ["e-factura"],
    ...overrides,
  };
}

describe("folding and whole-word matching", () => {
  it("matches across the three ways Romanian writes the same word", () => {
    // A site writes "factură", the seller typed "factura", and a third page
    // uses the cedilla form. All three must be the same word.
    for (const written of ["factură", "factura", "facturã"]) {
      expect(findKeyword(foldText(`Emitem o ${written} lunar.`), "factura")).not.toBeNull();
    }
    expect(fold("Șoseaua Țării")).toBe("soseaua tarii");
  });

  it("does not match a keyword buried inside a longer word", () => {
    // The bug this prevents: "CRM" matching "microcrm", or "ERP" matching
    // every page that says "superb".
    expect(findKeyword(foldText("Suntem o echipa superba."), "erp")).toBeNull();
    expect(findKeyword(foldText("Folosim un ERP modern."), "erp")).not.toBeNull();
  });

  it("matches a multi-word keyword across a line break", () => {
    const text = foldText("Avem un magazin\n   online de 10 ani.");
    expect(findKeyword(text, "magazin online")).not.toBeNull();
  });

  it("still anchors keywords that start or end with punctuation", () => {
    expect(keywordPattern(".net")).not.toBeNull();
    expect(findKeyword(foldText("Construim in .NET si Java."), ".net")).not.toBeNull();
  });

  it("returns the snippet with its diacritics intact", () => {
    // The offset map exists for exactly this: matching happens on folded text,
    // but the evidence a user reads must be the sentence as published.
    const match = findKeyword(
      foldText("Compania noastră emite factură electronică către ANAF."),
      "factura electronica",
    );
    expect(match?.snippet).toContain("factură electronică");
  });

  it("ignores a keyword too short to be meaningful", () => {
    expect(keywordPattern("a")).toBeNull();
  });

  it("matches a short capitalised keyword case-sensitively", () => {
    // The live agent targets "IT". Case-insensitively that matches the English
    // word "it" several times a paragraph on the English homepage of every
    // Romanian software company — turning the signal component from a constant
    // zero into constant noise.
    expect(findKeyword(foldText("This is what it does for you."), "IT")).toBeNull();
    expect(findKeyword(foldText("Servicii IT pentru companii."), "IT")).not.toBeNull();
  });

  it("keeps longer keywords case-insensitive", () => {
    // "e-Factura" and "e-factura" are the same word, and a seller should not
    // have to guess a site's capitalisation.
    expect(findKeyword(foldText("Modulul e-Factura este gratuit."), "e-factura")).not.toBeNull();
    expect(findKeyword(foldText("CONTABILITATE ONLINE"), "contabilitate")).not.toBeNull();
  });
});

describe("page classification", () => {
  it("ranks the homepage above a deep product page", () => {
    // What a company puts on its homepage is what it wants to be understood
    // as. The same word three clicks down is a side activity.
    expect(classifyPage("https://exemplu.ro/").strength).toBeGreaterThan(
      classifyPage("https://exemplu.ro/products").strength,
    );
  });

  it("treats a bare origin and a trailing slash as the same page", () => {
    expect(classifyPage("https://exemplu.ro").key).toBe("home");
    expect(classifyPage("https://exemplu.ro/").key).toBe("home");
  });

  it("recognises the Romanian spellings", () => {
    expect(classifyPage("https://exemplu.ro/despre-noi").key).toBe("about");
    expect(classifyPage("https://exemplu.ro/preturi").key).toBe("offering");
    expect(classifyPage("https://exemplu.ro/clienti").key).toBe("customers");
  });
});

describe("keywordHits", () => {
  it("reports each keyword once, from the best page it appears on", () => {
    const hits = keywordHits(
      snapshot([
        { url: "https://exemplu.ro/products", text: "Solutii de e-factura." },
        { url: "https://exemplu.ro/", text: "Platforma de e-factura pentru IMM." },
      ]),
      ["e-factura"],
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].pageClass).toBe("home");
  });
});

describe("KeywordSiteSignalSource", () => {
  const source = new KeywordSiteSignalSource();

  it("applies with no previous scan — the whole point of this source", () => {
    expect(source.isApplicable(context())).toBe(true);
  });

  it("does not apply when the agent named no keywords", () => {
    expect(source.isApplicable(context({ keywords: [] }))).toBe(false);
  });

  it("fires on a first scan and links to the page it read", async () => {
    const site = snapshot([
      { url: "https://exemplu.ro/", text: "Platformă de e-factură pentru IMM-uri." },
    ]);
    const signals = await source.scan(context({ site: async () => site }));

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("keyword_on_site");
    expect(signals[0].evidenceUrl).toBe("https://exemplu.ro/");
    expect(signals[0].title).toContain("homepage");
    expect(signals[0].payload?.hits).toHaveLength(1);
  });

  it("scores more distinct keywords higher, but not without limit", async () => {
    const one = await source.scan(
      context({
        keywords: ["e-factura"],
        site: async () => snapshot([{ url: "https://exemplu.ro/", text: "e-factura" }]),
      }),
    );
    const many = await source.scan(
      context({
        keywords: ["e-factura", "SAF-T", "contabilitate", "ERP", "facturare"],
        site: async () =>
          snapshot([
            { url: "https://exemplu.ro/", text: "e-factura SAF-T contabilitate ERP facturare" },
          ]),
      }),
    );

    expect(many[0].strength).toBeGreaterThan(one[0].strength);
    expect(many[0].strength).toBeLessThanOrEqual(0.85);
  });

  it("keys on the keywords it matched, not on every keyword the agent has", async () => {
    const site = snapshot([{ url: "https://exemplu.ro/", text: "Emitem e-factura." }]);

    const narrow = await source.scan(context({ keywords: ["e-factura"], site: async () => site }));
    const wide = await source.scan(
      context({ keywords: ["e-factura", "nimic-de-gasit"], site: async () => site }),
    );

    // Adding a keyword that matches nothing must not orphan the signal the
    // matched one already produced.
    expect(narrow[0].dedupeKey).toBe(wide[0].dedupeKey);
  });

  it("emits nothing when the site is unreachable", async () => {
    expect(await source.scan(context({ site: async () => null }))).toEqual([]);
  });
});
