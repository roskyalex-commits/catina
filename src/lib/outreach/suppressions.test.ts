import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifySuppression,
  domainOf,
  isSuppressed,
  suppressedAmong,
} from "./suppressions";

/**
 * The failure mode here is not a wrong number on a dashboard — it is mailing
 * somebody who asked not to be mailed. So the tests are weighted towards the
 * two ways that happens: a domain-level opt-out honoured only for one address,
 * and a lookup failure treated as "nobody is suppressed".
 */

function dbReturning(
  rows: { value: string; kind: string }[],
  error?: string,
): SupabaseClient {
  const result = error ? { data: null, error: { message: error } } : { data: rows, error: null };
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => Promise.resolve(result)),
  };
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

describe("a domain opt-out covers everyone under it", () => {
  it("blocks an address when the company's domain is suppressed", async () => {
    /*
     * "Take our whole company off your list" is how a B2B opt-out usually
     * arrives. Honouring it only for the person who wrote is how the second
     * complaint happens — and the second one is the expensive one.
     */
    const db = dbReturning([{ value: "firma.ro", kind: "domain" }]);
    const blocked = await suppressedAmong(db, "org-1", [
      "ion@firma.ro",
      "maria@firma.ro",
      "andrei@altcineva.ro",
    ]);

    expect(blocked.has("ion@firma.ro")).toBe(true);
    expect(blocked.has("maria@firma.ro")).toBe(true);
    expect(blocked.has("andrei@altcineva.ro")).toBe(false);
  });

  it("blocks a single suppressed address without touching its colleagues", async () => {
    const db = dbReturning([{ value: "ion@firma.ro", kind: "address" }]);
    const blocked = await suppressedAmong(db, "org-1", ["ion@firma.ro", "maria@firma.ro"]);

    expect(blocked.has("ion@firma.ro")).toBe(true);
    expect(blocked.has("maria@firma.ro")).toBe(false);
  });

  it("matches regardless of the casing or whitespace it was stored with", async () => {
    const db = dbReturning([{ value: "ion@firma.ro", kind: "address" }]);
    expect(await isSuppressed(db, "org-1", "  ION@Firma.RO  ")).toBe(true);
  });
});

describe("it fails closed", () => {
  it("suppresses everything when the lookup errors", async () => {
    /*
     * The important direction. A blocked send is recoverable — the user retries.
     * An opt-out mailed because PostgREST was briefly unavailable is not.
     */
    const db = dbReturning([], "connection reset");
    const blocked = await suppressedAmong(db, "org-1", ["ion@firma.ro", "maria@firma.ro"]);

    expect(blocked.size).toBe(2);
  });

  it("returns nothing for an empty request rather than querying", async () => {
    const db = dbReturning([]);
    expect((await suppressedAmong(db, "org-1", [])).size).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
  });
});

describe("classifying what someone typed", () => {
  it("reads an address as an address and a domain as a domain", () => {
    expect(classifySuppression("ion@firma.ro")).toMatchObject({
      value: "ion@firma.ro",
      kind: "address",
    });
    expect(classifySuppression("firma.ro")).toMatchObject({
      value: "firma.ro",
      kind: "domain",
    });
  });

  it("accepts the @domain.ro form people actually type", () => {
    expect(classifySuppression("@firma.ro")).toMatchObject({
      value: "firma.ro",
      kind: "domain",
    });
  });

  it("rejects a bare token rather than storing something that blocks nothing", () => {
    // Stored as an address, `firma` would never equal any address or domain,
    // so the entry would sit in the table looking like protection.
    expect(classifySuppression("firma")).toBeNull();
    expect(classifySuppression("   ")).toBeNull();
    expect(classifySuppression("ion@")).toBeNull();
  });
});

describe("domainOf", () => {
  it("takes the last @, so a quoted local part cannot mislead it", () => {
    expect(domainOf("ion@firma.ro")).toBe("firma.ro");
    expect(domainOf("a@b@firma.ro")).toBe("firma.ro");
  });

  it("returns null when there is no domain", () => {
    expect(domainOf("firma.ro")).toBeNull();
    expect(domainOf("@firma.ro")).toBeNull();
    expect(domainOf("ion@")).toBeNull();
  });
});
