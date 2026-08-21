import { describe, expect, it } from "vitest";
import { generateCandidates } from "./patterns";
import {
  MIN_NAME_CONFIDENCE,
  nameOrderForSource,
  resolveNameParts,
  resolvePersonName,
} from "./romanian-names";

/**
 * Every name here is a real row from `people`, not an invented example. The bug
 * this file guards against was invisible precisely because the fixtures used to
 * test `patterns.ts` were written given-first, the way a developer writes their
 * own name — so the register's actual shape never reached the assertion.
 */

describe("ONRC names are surname-first", () => {
  it("reads Podar Simona Mihaela as Simona Podar", () => {
    // The name that made the bug concrete: the naive split yields
    // `podar.mihaela@`, taking the surname as the given name and a *second*
    // given name as the surname. Both halves wrong from one mistake.
    const resolved = resolveNameParts("Podar Simona Mihaela", {
      order: "surname-first",
    });
    expect(resolved.firstName).toBe("simona");
    expect(resolved.lastName).toBe("podar");
    expect(resolved.confidence).toBeGreaterThanOrEqual(MIN_NAME_CONFIDENCE);
  });

  it("drops the patronymic initial in Chertes L Liviu", () => {
    // `L` is the father's given name abbreviated. It is not part of an address,
    // and left in it would become the surname.
    const resolved = resolveNameParts("Chertes L Liviu", { order: "surname-first" });
    expect(resolved.firstName).toBe("liviu");
    expect(resolved.lastName).toBe("chertes");
  });

  it("handles the Hungarian names common in Transylvania", () => {
    // Hungarian is natively surname-first too, and the register writes it that
    // way, so the same rule holds — but only because the lexicon was derived
    // from this register rather than from a list of Romanian forenames.
    const resolved = resolveNameParts("Tussay Szilard", { order: "surname-first" });
    expect(resolved.lastName).toBe("tussay");
    expect(resolved.firstName).toBe("szilard");
  });

  it("takes the first given name, not the last", () => {
    const resolved = resolveNameParts("Bodea Maria Magdalena", {
      order: "surname-first",
    });
    expect(resolved.firstName).toBe("maria");
  });

  it("folds diacritics the way an address does", () => {
    const resolved = resolveNameParts("Apăvăloaiei Cristian", {
      order: "surname-first",
    });
    expect(resolved.lastName).toBe("apavaloaiei");
    expect(resolved.firstName).toBe("cristian");
  });

  it("prefers the short form of a compound given name, keeping the long one", () => {
    /*
     * `Lup Dragoș-Teodor` signs off as Dragoș, so `dragos.lup@` leads. But
     * `dragosteodor.lup@` is a real convention at some companies and no
     * inference can separate the two — that is what the variants are for, and
     * what the verifier settles later at one credit each.
     */
    const resolved = resolveNameParts("Lup Dragoș-Teodor", { order: "surname-first" });
    expect(resolved.lastName).toBe("lup");
    expect(resolved.firstName).toBe("dragos");
    expect(resolved.firstNameVariants).toContain("dragosteodor");
  });

  it("keeps a double-barrelled surname whole, and its halves as variants", () => {
    // The mirror image: dropping half of `Pop-Vișan` renames the person, so the
    // full form leads where a given name's first element would.
    const resolved = resolveNameParts("Pop-Vișan Mihai-Adrian", {
      order: "surname-first",
    });
    expect(resolved.lastName).toBe("popvisan");
    expect(resolved.lastNameVariants).toContain("pop");
    expect(resolved.firstName).toBe("mihai");
  });
});

describe("the lexicon overrides the caller's assumption", () => {
  it("reads a given-first name correctly even when told surname-first", () => {
    /*
     * The important property. A source label is a guess about a whole feed; the
     * lexicon is evidence about this one name. If a `website` row happens to
     * print "Popescu Ion", or an ONRC row is written the other way round, the
     * evidence has to win or the label becomes a way to be confidently wrong.
     */
    const resolved = resolveNameParts("Ion Popescu", { order: "surname-first" });
    expect(resolved.firstName).toBe("ion");
    expect(resolved.lastName).toBe("popescu");
    expect(resolved.basis).toBe("lexicon");
  });

  it("falls back to the convention only when the lexicon is silent", () => {
    const resolved = resolveNameParts("Zzyzx Qqwerty", { order: "surname-first" });
    expect(resolved.basis).toBe("convention");
    expect(resolved.lastName).toBe("zzyzx");
    // Still sendable: two unknown tokens is what a foreign name looks like, and
    // the source's own convention is real information.
    expect(resolved.confidence).toBeGreaterThanOrEqual(MIN_NAME_CONFIDENCE);
  });
});

describe("a name it cannot resolve is skipped, not guessed", () => {
  it("stays below the threshold when nothing is known", () => {
    const resolved = resolveNameParts("Zzyzx Qqwerty");
    expect(resolved.basis).toBe("unresolved");
    expect(resolved.confidence).toBeLessThan(MIN_NAME_CONFIDENCE);
  });

  it("stays below the threshold for a single token", () => {
    // One token cannot produce `first.last`, and the caller must not fill the
    // other half in from somewhere else.
    const resolved = resolveNameParts("Popescu", { order: "surname-first" });
    expect(resolved.confidence).toBeLessThan(MIN_NAME_CONFIDENCE);
    expect(resolved.lastName).toBeUndefined();
  });

  it("recovers a name typed with hyphens instead of spaces", () => {
    // `Bota-Cristian-Lucian` — two rows in the register look like this. Before
    // this case it resolved to a single token and was skipped entirely.
    const resolved = resolveNameParts("Bota-Cristian-Lucian", {
      order: "surname-first",
    });
    expect(resolved.lastName).toBe("bota");
    expect(resolved.firstName).toBe("cristian");
    expect(resolved.confidence).toBeGreaterThanOrEqual(MIN_NAME_CONFIDENCE);
  });

  it("strips a sole-trader suffix rather than treating it as a name", () => {
    // `Pop Ioan Persoana Fizica Autorizata` is a person, not a four-part name.
    const resolved = resolveNameParts("Pop Ioan Persoană Fizică Autorizată", {
      order: "surname-first",
    });
    expect(resolved.lastName).toBe("pop");
    expect(resolved.firstName).toBe("ioan");
  });
});

describe("source conventions", () => {
  it("knows the register writes surname-first and vendors do not", () => {
    expect(nameOrderForSource("onrc")).toBe("surname-first");
    expect(nameOrderForSource("website")).toBe("given-first");
    expect(nameOrderForSource("hunter")).toBe("given-first");
  });

  it("admits it does not know an unfamiliar source", () => {
    // "auto" rather than a default, so an unrecognised feed produces skipped
    // names instead of a systematic reversal nobody notices.
    expect(nameOrderForSource("some-new-vendor")).toBe("auto");
    expect(nameOrderForSource(null)).toBe("auto");
  });

  it("prefers already-split columns over inference", () => {
    const resolved = resolvePersonName({
      fullName: "Podar Simona Mihaela",
      firstName: "Simona",
      lastName: "Podar",
      source: "onrc",
    });
    expect(resolved.firstName).toBe("simona");
    expect(resolved.lastName).toBe("podar");
  });
});

describe("end to end: the address Gojiberry would produce", () => {
  it("builds simona.podar@ and not podar.mihaela@", () => {
    /*
     * The whole point, asserted against the real generator. This is the shape
     * the user reported seeing from the competitor for every lead it found.
     */
    const { firstName, lastName } = resolvePersonName({
      fullName: "Podar Simona Mihaela",
      source: "onrc",
    });

    const [candidate] = generateCandidates(`${firstName} ${lastName}`, "firma.ro", {
      knownPattern: "first.last",
      max: 1,
    });

    expect(candidate.address).toBe("simona.podar@firma.ro");
    expect(candidate.address).not.toBe("podar.mihaela@firma.ro");
  });
});
