import { describe, expect, it } from "vitest";
import { orgNameFromEmail, slugCandidates, slugFromEmail } from "./org";

describe("slugFromEmail", () => {
  it("lowercases and strips punctuation", () => {
    expect(slugFromEmail("Alex.Rosky+catina@gmail.com")).toBe("alex-rosky-catina");
  });

  /** The reason NFD normalisation is there rather than a plain a-z filter. */
  it("keeps the letter under a Romanian diacritic", () => {
    expect(slugFromEmail("Ștefan@example.ro")).toBe("stefan");
    expect(slugFromEmail("ana.țîrlea@example.ro")).toBe("ana-tirlea");
    expect(slugFromEmail("mihăiță@example.ro")).toBe("mihaita");
  });

  it("never returns an empty slug", () => {
    expect(slugFromEmail("+++@example.com")).toBe("workspace");
    expect(slugFromEmail("")).toBe("workspace");
    expect(slugFromEmail("@example.com")).toBe("workspace");
  });

  it("has no leading or trailing separator", () => {
    for (const email of ["_alex_@x.com", ".a.@x.com", "-b-@x.com"]) {
      const slug = slugFromEmail(email);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("bounds the length", () => {
    expect(slugFromEmail(`${"a".repeat(200)}@x.com`)).toHaveLength(40);
  });
});

describe("orgNameFromEmail", () => {
  it("prefers the company domain", () => {
    expect(orgNameFromEmail("ana@exemplu-retail.ro")).toBe("Exemplu-retail");
  });

  it("falls back to the person for a free mailbox", () => {
    expect(orgNameFromEmail("rosky.alex@gmail.com")).toBe("Rosky alex's workspace");
    expect(orgNameFromEmail("ana@yahoo.ro")).toBe("Ana's workspace");
  });

  it("survives a malformed address", () => {
    expect(orgNameFromEmail("nodomain")).toBe("Nodomain's workspace");
  });
});

describe("slugCandidates", () => {
  it("offers the bare slug first", () => {
    expect(slugCandidates("alex")[0]).toBe("alex");
  });

  it("numbers the rest from 2, so the second user is alex-2", () => {
    const candidates = slugCandidates("alex");
    expect(candidates[1]).toBe("alex-2");
    expect(candidates[2]).toBe("alex-3");
  });

  it("returns a bounded list rather than looping forever", () => {
    expect(slugCandidates("alex")).toHaveLength(25);
    expect(new Set(slugCandidates("alex")).size).toBe(25);
  });
});
