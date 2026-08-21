import { describe, expect, it } from "vitest";
import {
  isGenericTitle,
  mergePerson,
  personKey,
  type ExistingPerson,
} from "./repository";
import type { FoundPerson } from "./types";

/**
 * These are the rules that decide what happens to 29,551 existing rows the
 * first time a paid provider runs. Getting them wrong does not fail loudly — it
 * either duplicates people, so sourcing picks between a good record and a poor
 * one at random, or it overwrites real job titles with the register's
 * `administrator` and undoes the entire reason for buying the data.
 */

function found(overrides: Partial<FoundPerson> = {}): FoundPerson {
  return {
    fullName: "Simona Podar",
    provider: "vendor",
    ...overrides,
  };
}

/** An ONRC row as it exists today: surname-first name, generic title. */
function onrc(overrides: Partial<ExistingPerson> = {}): ExistingPerson {
  return {
    id: "existing-1",
    companyId: "c1",
    fullName: "Podar Simona Mihaela",
    firstName: "simona",
    lastName: "podar",
    title: "administrator",
    seniority: "c_level",
    department: null,
    linkedinUrl: null,
    location: null,
    source: "onrc",
    ...overrides,
  };
}

describe("identity", () => {
  it("matches the same person across two name orders", () => {
    /*
     * The whole merge depends on this. ONRC writes `Podar Simona Mihaela` and a
     * vendor writes `Simona Podar`; only the resolved halves make those one
     * human, which is why the key is not built from the display name.
     */
    expect(personKey("c1", "simona", "podar")).toBe(personKey("c1", "Simona", "Podar"));
  });

  it("folds diacritics the way an address does", () => {
    expect(personKey("c1", "Ștefan", "Țîră")).toBe(personKey("c1", "stefan", "tira"));
  });

  it("scopes to the company, so two Ion Popescus are two people", () => {
    expect(personKey("c1", "ion", "popescu")).not.toBe(personKey("c2", "ion", "popescu"));
  });

  it("has no identity without both halves", () => {
    expect(personKey("c1", "simona", null)).toBeNull();
    expect(personKey("c1", null, "podar")).toBeNull();
  });
});

describe("generic titles", () => {
  it("knows the register's vocabulary carries no job information", () => {
    for (const title of ["administrator", "Administrator", "asociat unic", "reprezentant legal"]) {
      expect(isGenericTitle(title), title).toBe(true);
    }
  });

  it("recognises a real role", () => {
    for (const title of ["Director de Marketing", "CTO", "Head of Operations"]) {
      expect(isGenericTitle(title), title).toBe(false);
    }
  });

  it("treats a missing title as generic", () => {
    expect(isGenericTitle(null)).toBe(true);
    expect(isGenericTitle("  ")).toBe(true);
  });
});

describe("enrich, never downgrade", () => {
  it("lets a real vendor title replace the register's administrator", () => {
    // The entire reason for buying the data.
    const write = mergePerson("c1", found({ title: "Director de Marketing" }), onrc(), "vendor");

    expect(write?.id).toBe("existing-1");
    expect(write?.title).toBe("Director de Marketing");
    // Seniority is recomputed from whichever title won, so the two cannot
    // disagree after a merge.
    expect(write?.seniority).toBe("director");
  });

  it("refuses to let a vendor's `administrator` overwrite a real title", () => {
    const existing = onrc({ title: "Head of Operations", seniority: "director" });
    const write = mergePerson("c1", found({ title: "administrator" }), existing, "vendor");

    expect(write?.title).toBe("Head of Operations");
  });

  it("keeps the register's display name over a vendor's spelling", () => {
    // `SIMONA PODAR` is not an improvement on the legal spelling shown in the UI.
    const write = mergePerson("c1", found({ fullName: "SIMONA PODAR" }), onrc(), "vendor");
    expect(write?.full_name).toBe("Podar Simona Mihaela");
  });

  it("fills the fields the register never had", () => {
    const write = mergePerson(
      "c1",
      found({
        title: "CTO",
        department: "Engineering",
        linkedinUrl: "https://linkedin.com/in/simona",
        location: "Cluj-Napoca",
      }),
      onrc(),
      "vendor",
    );

    expect(write?.department).toBe("Engineering");
    expect(write?.linkedin_url).toBe("https://linkedin.com/in/simona");
    expect(write?.location).toBe("Cluj-Napoca");
  });

  it("does not blank a field the vendor omitted", () => {
    const existing = onrc({ department: "Finance", linkedinUrl: "https://x/in/a" });
    const write = mergePerson("c1", found({ title: "CFO" }), existing, "vendor");

    expect(write?.department).toBe("Finance");
    expect(write?.linkedin_url).toBe("https://x/in/a");
  });

  it("keeps the register as the source of record for a person it gave us", () => {
    // A vendor enriched the row; it did not originate it.
    const write = mergePerson("c1", found({ title: "CTO" }), onrc(), "vendor");
    expect(write?.source).toBe("onrc");
  });
});

describe("a person we do not hold", () => {
  it("becomes an insert, with no id", () => {
    const write = mergePerson("c1", found({ title: "Director de Vanzari" }), undefined, "vendor");

    expect(write?.id).toBeUndefined();
    expect(write?.first_name).toBe("simona");
    expect(write?.last_name).toBe("podar");
    expect(write?.source).toBe("vendor");
  });

  it("is skipped when the name cannot be resolved into halves", () => {
    /*
     * No halves means no identity to dedupe on and no address to build later,
     * so the row would be a name we can do nothing with — and it would
     * duplicate on every subsequent run, since nothing could match it.
     */
    expect(mergePerson("c1", found({ fullName: "Ionut" }), undefined, "vendor")).toBeNull();
  });

  it("stays an insert when merged against a row queued in the same batch", () => {
    // A pending insert carries an empty id. Treating that as an update would
    // issue `.eq("id", "")` and fail the batch.
    const pending = onrc({ id: "" });
    const write = mergePerson("c1", found({ title: "CTO" }), pending, "vendor");

    expect(write?.id).toBeUndefined();
    expect(write?.title).toBe("CTO");
  });
});
