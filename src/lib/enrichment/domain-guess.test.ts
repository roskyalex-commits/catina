import { describe, expect, it } from "vitest";
import {
  candidateDomains,
  foldDiacritics,
  isGuessable,
  nameTokens,
  pageMentionsCui,
  pageMentionsName,
  verifyDomain,
} from "./domain-guess";

/**
 * Company names here are real ones from the imported Cluj slice, because the
 * failure mode that matters is a guess that confidently finds somebody else's
 * website.
 */

describe("foldDiacritics", () => {
  it("folds the Romanian letters", () => {
    expect(foldDiacritics("Ștefănescu")).toBe("Stefanescu");
    expect(foldDiacritics("Gruiţa")).toBe("Gruita");
    expect(foldDiacritics("Apăvăloaiei")).toBe("Apavaloaiei");
  });
});

describe("nameTokens", () => {
  it("strips the legal form", () => {
    expect(nameTokens("TECHNOPILOT S.R.L.")).toEqual(["technopilot"]);
    expect(nameTokens("ROBITE SA")).toEqual(["robite"]);
    expect(nameTokens("SC KPMG ROMANIA SRL")).toEqual(["kpmg", "romania"]);
  });

  it("handles punctuation and doubled spacing", () => {
    expect(nameTokens("M & M  DESIGN SRL")).toEqual(["design"]);
  });

  it("returns nothing for a name that is only a legal form", () => {
    expect(nameTokens("SRL")).toEqual([]);
  });
});

describe("isGuessable", () => {
  it.each([
    "TECHNOPILOT S.R.L.",
    "QUBICSDATA S.R.L.",
    "MIDANTOP SOFT S.R.L.",
    "DORABIT S.R.L.",
  ])("accepts the distinctive name %s", (name) => {
    expect(isGuessable(name)).toBe(true);
  });

  it.each([
    "COM IMPEX SRL",
    "PROD SERV SRL",
    "TOTAL CONSULTING SRL",
    "SRL",
  ])("refuses the generic name %s", (name) => {
    // `comimpex.ro` belongs to hundreds of companies; a page found there would
    // prove nothing about this one.
    expect(isGuessable(name)).toBe(false);
  });
});

describe("candidateDomains", () => {
  it("puts the obvious .ro guess first", () => {
    const candidates = candidateDomains("TECHNOPILOT S.R.L.");
    expect(candidates[0]).toEqual({ domain: "technopilot.ro", basis: "full" });
  });

  it("tries every stem on .ro before any .com", () => {
    // A Romanian company on a .com is the exception; spending lookups on
    // stem-one-every-TLD before stem-two-on-.ro wastes them.
    const domains = candidateDomains("NESSUS GROUP SRL", 6).map((c) => c.domain);
    const firstCom = domains.findIndex((d) => d.endsWith(".com"));
    const lastRo = domains.map((d) => d.endsWith(".ro")).lastIndexOf(true);
    expect(lastRo).toBeLessThan(firstCom);
  });

  it("drops generic words to form a distinctive stem", () => {
    const domains = candidateDomains("NOVABYTE TECHNOLOGIES SOFTWARE S.R.L.").map(
      (c) => c.domain,
    );
    expect(domains).toContain("novabytetechnologiessoftware.ro");
    expect(domains).toContain("novabytetechnologies.ro");
  });

  it("does not reduce to a single short word when generics are dropped", () => {
    // "TUDOR SOLUTIONS" minus the generic "solutions" is "tudor" — the same
    // trap as guessing the first word, arriving by another route.
    const domains = candidateDomains("TUDOR SOLUTIONS S.R.L.").map((c) => c.domain);
    expect(domains).not.toContain("tudor.ro");
  });

  it("offers a hyphenated form for multi-word names", () => {
    const domains = candidateDomains("XITING ROM CONSTRUCT SRL").map((c) => c.domain);
    expect(domains.some((d) => d.includes("-"))).toBe(true);
  });

  it("never guesses a single word from a multi-word name", () => {
    // `all.ro`, `business.com`, `cont.ro` — all real false positives from the
    // first live run.
    for (const name of ["ALL BEFORE SRL", "Z BUSINESS SRL", "TUDOR SOLUTIONS S.R.L."]) {
      for (const candidate of candidateDomains(name)) {
        const stem = candidate.domain.split(".")[0];
        expect(stem.replace(/-/g, "").length).toBeGreaterThan(6);
      }
    }
  });

  it("returns nothing for a name not worth guessing", () => {
    expect(candidateDomains("COM IMPEX SRL")).toEqual([]);
  });

  it("respects the limit, because each candidate costs a lookup", () => {
    expect(candidateDomains("ALPHA BETA GAMMA DELTA SRL", 3)).toHaveLength(3);
  });

  it("never emits a malformed domain", () => {
    for (const name of ["A B SRL", "X SRL", "ZZ SRL", "TECHNOPILOT SRL"]) {
      for (const candidate of candidateDomains(name)) {
        expect(candidate.domain).toMatch(/^[a-z0-9][a-z0-9-]{1,62}\.[a-z]{2,}$/);
      }
    }
  });
});

describe("pageMentionsCui", () => {
  it("finds a bare CUI", () => {
    expect(pageMentionsCui("<p>CUI 21457545</p>", "21457545")).toBe(true);
  });

  it("finds it with the RO prefix", () => {
    expect(pageMentionsCui("<p>RO21457545</p>", "21457545")).toBe(true);
  });

  it("finds it written with separators", () => {
    // Romanian footers write it several ways; the number is the same.
    expect(pageMentionsCui("C.U.I.: 21 457 545", "21457545")).toBe(true);
    expect(pageMentionsCui("CUI: 21.457.545", "21457545")).toBe(true);
  });

  it("does not match a longer number containing it", () => {
    // The whole point is proof of identity, so a substring hit is a false one.
    expect(pageMentionsCui("order 9214575451", "21457545")).toBe(false);
  });

  it("does not match a different company", () => {
    expect(pageMentionsCui("CUI 12345678", "21457545")).toBe(false);
  });
});

describe("pageMentionsName", () => {
  it("matches the distinctive name regardless of diacritics or case", () => {
    expect(pageMentionsName("<title>TechnoPilot — acasă</title>", "TECHNOPILOT SRL")).toBe(true);
  });

  it("requires every distinctive token, not just one", () => {
    // "group" alone is not NESSUS GROUP.
    expect(pageMentionsName("<p>our group</p>", "NESSUS GROUP SRL")).toBe(false);
    expect(pageMentionsName("<p>nessus group</p>", "NESSUS GROUP SRL")).toBe(true);
  });

  it("is false when there is nothing distinctive to match", () => {
    expect(pageMentionsName("anything", "COM IMPEX SRL")).toBe(false);
  });
});

describe("verifyDomain", () => {
  it("accepts a CUI match with high confidence", () => {
    const verdict = verifyDomain(
      { reachable: true, cuiOnPage: true, nameOnPage: true },
      { distinctiveName: true },
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.confidence).toBeGreaterThan(0.9);
  });

  it("refuses a name match with no CUI, however distinctive", () => {
    // Measured: accepting these produced business.com for Z BUSINESS SRL. The
    // name is what the guess was built from, so matching it is near-circular.
    const verdict = verifyDomain(
      { reachable: true, cuiOnPage: false, nameOnPage: true },
      { distinctiveName: true },
    );
    expect(verdict.accepted).toBe(false);
  });

  it("still scores a distinctive near-miss above a generic one", () => {
    const distinctive = verifyDomain(
      { reachable: true, cuiOnPage: false, nameOnPage: true },
      { distinctiveName: true },
    );
    const generic = verifyDomain(
      { reachable: true, cuiOnPage: false, nameOnPage: true },
      { distinctiveName: false },
    );
    expect(distinctive.confidence).toBeGreaterThan(generic.confidence);
  });

  it("refuses a page that is not about this company", () => {
    const verdict = verifyDomain(
      { reachable: true, cuiOnPage: false, nameOnPage: false },
      { distinctiveName: true },
    );
    expect(verdict.accepted).toBe(false);
  });

  it("refuses an unreachable domain even if everything else looked right", () => {
    const verdict = verifyDomain(
      { reachable: false, cuiOnPage: true, nameOnPage: true },
      { distinctiveName: true },
    );
    expect(verdict.accepted).toBe(false);
  });
});
