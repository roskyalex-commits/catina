import { describe, expect, it } from "vitest";
import {
  bestCompanyPattern,
  inferCompanyPattern,
  pairAddresses,
  readPatternFromShape,
  type KnownPerson,
} from "./pattern-discovery";

/**
 * The people here are shaped like real `people` rows after the name backfill:
 * `fullName` surname-first as ONRC writes it, `firstName`/`lastName` already
 * resolved. Anything that re-splits `fullName` will fail these.
 */
const ANDREI: KnownPerson = {
  id: "p1",
  fullName: "Pop Andrei",
  firstName: "andrei",
  lastName: "pop",
};
const SIMONA: KnownPerson = {
  id: "p2",
  fullName: "Podar Simona Mihaela",
  firstName: "simona",
  lastName: "podar",
};

describe("pairing an address to a person we already hold", () => {
  it("confirms first.last against an ONRC administrator", () => {
    const [pair] = pairAddresses(["andrei.pop@firma.ro"], [ANDREI, SIMONA]);
    expect(pair.personId).toBe("p1");
    expect(pair.patterns).toContain("first.last");
    expect(pair.strong).toBe(true);
  });

  it("confirms flast, the other convention that actually shows up", () => {
    const [pair] = pairAddresses(["apop@firma.ro"], [ANDREI]);
    expect(pair.personId).toBe("p1");
    expect(pair.patterns).toContain("flast");
  });

  it("ignores role addresses entirely", () => {
    // `office@` is the company's, not a person's, however the names fall.
    expect(pairAddresses(["office@firma.ro", "contact@firma.ro"], [ANDREI])).toEqual([]);
  });

  it("returns nothing when the address matches nobody", () => {
    expect(pairAddresses(["gabriela.ionescu@firma.ro"], [ANDREI, SIMONA])).toEqual([]);
  });
});

describe("what it refuses to confirm", () => {
  it("will not claim a first-name-only address when two people could own it", () => {
    /*
     * `ana@firma.ro` with two Anas on the books is unattributable. Guessing
     * would put the wrong person's name in an email opener while looking
     * exactly as confident as a real match.
     */
    const anaPop: KnownPerson = {
      id: "p3",
      fullName: "Pop Ana",
      firstName: "ana",
      lastName: "pop",
    };
    const anaRus: KnownPerson = {
      id: "p4",
      fullName: "Rus Ana",
      firstName: "ana",
      lastName: "rus",
    };
    expect(pairAddresses(["ana@firma.ro"], [anaPop, anaRus])).toEqual([]);
  });

  it("accepts a first-name-only address when there is nobody else it could be", () => {
    const [pair] = pairAddresses(["andrei@firma.ro"], [ANDREI, SIMONA]);
    expect(pair.personId).toBe("p1");
    expect(pair.strong).toBe(false);
  });

  it("keeps the convention but drops the person when two strong matches collide", () => {
    /*
     * Two siblings running a family SRL — common in this register. Both resolve
     * to `pop.a`, so neither can be claimed, but the company still demonstrably
     * uses `f.last` and that is worth keeping.
     */
    const one: KnownPerson = {
      id: "p5",
      fullName: "Pop Andrei",
      firstName: "andrei",
      lastName: "pop",
    };
    const two: KnownPerson = {
      id: "p6",
      fullName: "Pop Alexandru",
      firstName: "alexandru",
      lastName: "pop",
    };
    const [pair] = pairAddresses(["a.pop@firma.ro"], [one, two]);
    expect(pair.personId).toBe("");
    expect(pair.patterns).toContain("f.last");
  });
});

describe("inferring the company convention", () => {
  it("reads first.last off a single confirmed pair", () => {
    const pairs = pairAddresses(["andrei.pop@firma.ro"], [ANDREI]);
    const inferred = inferCompanyPattern(pairs);
    expect(inferred?.pattern).toBe("first.last");
    expect(inferred?.samples).toBe(1);
  });

  it("is more confident with two agreeing samples than with one", () => {
    const one = inferCompanyPattern(pairAddresses(["andrei.pop@firma.ro"], [ANDREI]));
    const two = inferCompanyPattern(
      pairAddresses(
        ["andrei.pop@firma.ro", "simona.podar@firma.ro"],
        [ANDREI, SIMONA],
      ),
    );
    expect(two?.samples).toBe(2);
    expect(two!.confidence).toBeGreaterThan(one!.confidence);
  });

  it("returns null when there is no evidence at all", () => {
    expect(inferCompanyPattern([])).toBeNull();
  });

  it("survives a domain that mixes conventions", () => {
    // One legacy address should not outvote the convention everyone else uses.
    const third: KnownPerson = {
      id: "p7",
      fullName: "Rus Vasile",
      firstName: "vasile",
      lastName: "rus",
    };
    const inferred = inferCompanyPattern(
      pairAddresses(
        ["andrei.pop@firma.ro", "simona.podar@firma.ro", "vrus@firma.ro"],
        [ANDREI, SIMONA, third],
      ),
    );
    expect(inferred?.pattern).toBe("first.last");
    expect(inferred?.samples).toBe(3);
  });
});


describe("reading a convention off an address we cannot attribute", () => {
  it("reads first.last from a name the lexicon recognises", () => {
    // Real address from the first harvest. Cristian Petrache is nobody we hold,
    // and the convention is legible anyway.
    const reading = readPatternFromShape("cristian.petrache@codeunit.ro");
    expect(reading?.pattern).toBe("first.last");
  });

  it("reads last.first when the halves are the other way round", () => {
    expect(readPatternFromShape("popescu.ion@firma.ro")?.pattern).toBe("last.first");
  });

  it("reads flast from an initial glued to a surname", () => {
    expect(readPatternFromShape("apop@firma.ro")?.pattern).toBe("flast");
  });

  it("ignores trailing digits", () => {
    expect(readPatternFromShape("ion.popescu2@firma.ro")?.pattern).toBe("first.last");
  });

  it("says nothing about a departmental address", () => {
    /*
     * The failure that mattered in the first harvest: `marketing.constantin@`
     * and `relatii.publice@` both split cleanly in two, and reading either as
     * `first.last` would teach the domain a convention off a department name.
     */
    expect(readPatternFromShape("relatii.publice@firma.ro")).toBeNull();
    expect(readPatternFromShape("office@firma.ro")).toBeNull();
    expect(readPatternFromShape("comercial@firma.ro")).toBeNull();
  });

  it("says nothing when neither half is a name it knows", () => {
    expect(readPatternFromShape("depozit.central@firma.ro")).toBeNull();
  });
});

describe("choosing between a confirmed pair and a legible shape", () => {
  it("prefers the pair, and says so", () => {
    const best = bestCompanyPattern(
      pairAddresses(["andrei.pop@firma.ro"], [ANDREI]),
      ["andrei.pop@firma.ro", "gigel.vasilescu@firma.ro"],
    );
    expect(best?.basis).toBe("paired");
  });

  it("falls back to the shape when nothing pairs", () => {
    const best = bestCompanyPattern([], ["cristian.petrache@firma.ro"]);
    expect(best?.basis).toBe("shape");
    expect(best?.pattern).toBe("first.last");
  });

  it("never lets a shape reading reach a confirmed pair's confidence", () => {
    // Four agreeing shapes are still four guesses about four strangers.
    const shape = bestCompanyPattern([], [
      "ion.popescu@firma.ro",
      "maria.ionescu@firma.ro",
      "andrei.pop@firma.ro",
      "elena.rusu@firma.ro",
    ]);
    expect(shape!.confidence).toBeLessThanOrEqual(0.8);
  });

  it("returns null when there is neither", () => {
    expect(bestCompanyPattern([], ["office@firma.ro"])).toBeNull();
  });
});
