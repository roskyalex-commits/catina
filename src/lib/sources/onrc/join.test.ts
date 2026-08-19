import { describe, expect, it } from "vitest";
import {
  buildCaenNomenclature,
  buildStatusNomenclature,
  caenKey,
  extractDomain,
  normaliseRegNumber,
  principalCaen,
  resolveStatus,
  statusLabel,
  TERMINAL_STATUS_CODES,
} from "./join";

/**
 * The join rules, pinned without the 690MB file.
 *
 * The codes and shapes below are taken from the real 08.07.2026 release:
 * N_STARE_FIRMA (198 codes), N_VERSIUNE_CAEN (four versions) and N_CAEN
 * (3,741 rows spanning all of them).
 */

describe("normaliseRegNumber", () => {
  it("normalises case and spacing so the join cannot silently miss", () => {
    expect(normaliseRegNumber(" j12/1234/2020 ")).toBe("J12/1234/2020");
    expect(normaliseRegNumber("J12 / 1234 / 2020")).toBe("J12/1234/2020");
  });
});

describe("resolveStatus", () => {
  it("reads funcțiune as trading", () => {
    expect(resolveStatus([1048]).trading).toBe(true);
  });

  it("reads radiată as not trading", () => {
    // 49% of the register. Getting this wrong fills the database with the dead.
    expect(resolveStatus([1084]).trading).toBe(false);
  });

  it.each([...TERMINAL_STATUS_CODES])("treats %i as terminal", (code) => {
    expect(resolveStatus([code]).trading).toBe(false);
  });

  it("lets a terminal code beat a trading one", () => {
    // A company appears more than once with no date to order the rows, so the
    // safe reading wins: skipping a live company beats emailing a dead one.
    expect(resolveStatus([1048, 1084]).trading).toBe(false);
    expect(resolveStatus([1084, 1048]).trading).toBe(false);
  });

  it("ignores non-terminal events that a live company passes through", () => {
    // 1056 = schimbare formă juridică, 1053 = schimbare sediu.
    expect(resolveStatus([1048, 1056, 1053]).trading).toBe(true);
  });

  it("returns null when it cannot tell, never false", () => {
    expect(resolveStatus([]).trading).toBeNull();
    expect(resolveStatus([2069]).trading).toBeNull();
  });

  it("keeps the codes it saw", () => {
    expect(resolveStatus([1048, 1053]).codes).toEqual([1048, 1053]);
  });
});

describe("principalCaen", () => {
  const entry = (code: string, version = 3, principal = false) => ({
    code,
    version,
    principal,
  });

  it("returns undefined when there is nothing valid", () => {
    expect(principalCaen([])).toBeUndefined();
    expect(principalCaen([entry("nope")])).toBeUndefined();
  });

  it("prefers the register's own principal flag", () => {
    const picked = principalCaen([
      entry("4791"),
      entry("6201", 3, true),
      entry("4520"),
    ]);
    expect(picked?.code).toBe("6201");
  });

  it("prefers the newest CAEN revision when nothing is flagged", () => {
    // Rev 2 (2008) and Rev 3 (2025) both appear in the live data.
    const picked = principalCaen([entry("4791", 2), entry("6201", 3)]);
    expect(picked?.version).toBe(3);
  });

  it("is deterministic, so a re-import does not shuffle rows", () => {
    const entries = [entry("6202"), entry("6201"), entry("6209")];
    expect(principalCaen(entries)?.code).toBe("6201");
    expect(principalCaen([...entries].reverse())?.code).toBe("6201");
  });

  it("does not let a flagged old code lose to an unflagged new one", () => {
    const picked = principalCaen([entry("4791", 0, true), entry("6201", 3)]);
    expect(picked?.code).toBe("4791");
  });
});

describe("buildCaenNomenclature", () => {
  // SECTIUNEA, SUBSECTIUNEA, DIVIZIUNEA, GRUPA, CLASA, DENUMIRE, VERSIUNE_CAEN
  const rows = [
    ["A", "", "01", "011", "0111", "Cultura cerealelor", "0"],
    ["J", "", "62", "620", "6201", "Activitati de realizare a software-ului", "3"],
    ["J", "", "62", "620", "6201", "Realizarea de software la comanda", "2"],
    ["A", "", "01", "011", "", "Cultivarea plantelor", "3"],
  ];

  it("keys on code and version, because a code means different things", () => {
    const map = buildCaenNomenclature(rows);
    expect(map.get(caenKey("6201", 3))?.label).toContain("software-ului");
    expect(map.get(caenKey("6201", 2))?.label).toContain("comanda");
  });

  it("skips section and division headers that carry no company", () => {
    const map = buildCaenNomenclature(rows);
    expect(map.size).toBe(3);
  });
});

describe("buildStatusNomenclature", () => {
  it("maps codes to the register's own wording", () => {
    const map = buildStatusNomenclature([
      ["1048", "funcțiune"],
      ["1084", "radiată"],
      ["", "junk"],
    ]);
    expect(map.get(1048)).toBe("funcțiune");
    expect(map.get(1084)).toBe("radiată");
    expect(map.size).toBe(2);
  });
});

describe("statusLabel", () => {
  const nomenclature = new Map([
    [1048, "funcțiune"],
    [1084, "radiată"],
  ]);

  it("keeps the wording rather than flattening to a boolean", () => {
    // "radiată" and "faliment" are not the same news.
    expect(statusLabel([1084], nomenclature)).toBe("radiată");
  });

  it("joins several", () => {
    expect(statusLabel([1048, 1084], nomenclature)).toBe("funcțiune, radiată");
  });

  it("returns undefined for codes it cannot decode", () => {
    expect(statusLabel([9999], nomenclature)).toBeUndefined();
    expect(statusLabel([], nomenclature)).toBeUndefined();
  });
});

describe("extractDomain", () => {
  it("takes a bare domain", () => {
    expect(extractDomain("example.ro")).toBe("example.ro");
  });

  it("strips protocol, www and path", () => {
    expect(extractDomain("https://www.example.ro/contact")).toBe("example.ro");
    expect(extractDomain("HTTP://EXAMPLE.RO")).toBe("example.ro");
  });

  it("recovers a domain from an email typed into the website field", () => {
    expect(extractDomain("office@example.ro")).toBe("example.ro");
  });

  it("keeps a subdomain", () => {
    expect(extractDomain("shop.example.ro")).toBe("shop.example.ro");
  });

  it("drops anything that is not a hostname", () => {
    // A wrong domain attributes someone else's website to this company.
    for (const junk of ["", "-", "n/a", "nu are", "localhost", "http://", "..", "1234"]) {
      expect(extractDomain(junk)).toBeUndefined();
    }
  });

  it("drops a hostname with no plausible TLD", () => {
    expect(extractDomain("example")).toBeUndefined();
    expect(extractDomain("example.")).toBeUndefined();
  });

  it("ignores an absurdly long value", () => {
    expect(extractDomain("a".repeat(300) + ".ro")).toBeUndefined();
  });
});
