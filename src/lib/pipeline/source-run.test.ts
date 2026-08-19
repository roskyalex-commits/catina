import { describe, expect, it } from "vitest";
import { icpSchema } from "@/lib/icp/schema";
import {
  describeSource,
  pickContact,
  sourceRun,
  type RegistryCompany,
  type RegistryPerson,
  type SourceRunDeps,
} from "./source-run";

/**
 * The pipeline against fakes.
 *
 * The IO sits behind `SourceRunDeps` precisely so the parts that decide what
 * becomes a lead — contact choice, deduplication, ordering, the honest notes
 * when a run finds little — can be exercised without a database.
 */

const icp = icpSchema.parse({
  valueProp: "We sell bookkeeping automation to Romanian software firms.",
  targetTitles: ["Administrator"],
  caenCodes: ["6201", "6210"],
  keywords: ["software"],
  countries: ["RO"],
});

function company(id: string, over: Partial<RegistryCompany> = {}): RegistryCompany {
  return {
    id,
    dedupeKey: `cui:${id}`,
    name: `Company ${id}`,
    cui: id,
    caen: "6201",
    country: "RO",
    county: "Cluj",
    source: "onrc",
    ...over,
  };
}

function person(id: string, companyId: string, over: Partial<RegistryPerson> = {}): RegistryPerson {
  return {
    id,
    companyId,
    fullName: `Person ${id}`,
    title: "administrator",
    seniority: "c_level",
    ...over,
  };
}

function deps(over: Partial<SourceRunDeps> = {}): SourceRunDeps {
  return {
    findCompanies: async () => ({ companies: [], notes: [] }),
    findPeople: async () => [],
    existingPersonIds: async () => new Set<string>(),
    ...over,
  };
}

describe("pickContact", () => {
  it("returns undefined when a company has nobody", () => {
    expect(pickContact([])).toBeUndefined();
  });

  it("prefers the most senior", () => {
    const picked = pickContact([
      person("a", "c1", { seniority: "manager", fullName: "Aaa Aaa" }),
      person("b", "c1", { seniority: "founder", fullName: "Zzz Zzz" }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("is stable, so a re-run picks the same person", () => {
    const list = [
      person("a", "c1", { fullName: "Zamfir Ion" }),
      person("b", "c1", { fullName: "Albu Maria" }),
    ];
    expect(pickContact(list)?.id).toBe(pickContact([...list].reverse())?.id);
  });

  it("ranks an unknown seniority last rather than first", () => {
    const picked = pickContact([
      person("a", "c1", { seniority: undefined, fullName: "Aaa Aaa" }),
      person("b", "c1", { seniority: "director", fullName: "Zzz Zzz" }),
    ]);
    expect(picked?.id).toBe("b");
  });
});

describe("describeSource", () => {
  it("credits an exact CAEN match", () => {
    expect(describeSource(icp, company("1", { caen: "6201" }))).toEqual({
      label: "keyword",
      query: "CAEN 6201",
    });
  });

  it("credits a widened division match", () => {
    // The ICP asks for 6201; the adapter widened to division 62 and returned
    // 6209. Reporting the code it actually matched beats reporting the one the
    // user typed.
    expect(describeSource(icp, company("1", { caen: "6209" })).query).toBe(
      "CAEN 6209",
    );
  });

  it("does not credit CAEN for an unrelated division", () => {
    const result = describeSource(icp, company("1", { caen: "4321", name: "X SRL" }));
    expect(result.label).toBe("autopilot");
  });

  it("credits a keyword when the name matches and CAEN does not", () => {
    const result = describeSource(
      icpSchema.parse({ ...icp, caenCodes: [] }),
      company("1", { name: "ACME SOFTWARE SRL" }),
    );
    expect(result).toEqual({ label: "keyword", query: "software" });
  });

  it("falls back to autopilot when nothing specific matched", () => {
    const result = describeSource(
      icpSchema.parse({ ...icp, caenCodes: [], keywords: [] }),
      company("1", { name: "Neutral SRL" }),
    );
    expect(result).toEqual({ label: "autopilot", query: null });
  });
});

describe("sourceRun", () => {
  it("says why it found nothing rather than returning silently", async () => {
    const result = await sourceRun(deps(), { icp });
    expect(result.leads).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/No companies matched/);
  });

  it("creates one lead per company, not one per person", async () => {
    // A company with four administrators is one opportunity; mailing all four
    // is how a sending domain gets a reputation problem.
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({ companies: [company("c1")], notes: [] }),
        findPeople: async () => [
          person("p1", "c1"),
          person("p2", "c1"),
          person("p3", "c1"),
        ],
      }),
      { icp },
    );
    expect(result.leads).toHaveLength(1);
  });

  it("skips companies with no named contact and says how many", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [company("c1"), company("c2")],
          notes: [],
        }),
        findPeople: async () => [person("p1", "c1")],
      }),
      { icp },
    );
    expect(result.leads).toHaveLength(1);
    expect(result.companiesWithoutContact).toBe(1);
    expect(result.notes.join(" ")).toMatch(/no named contact/);
  });

  it("does not re-create a lead the agent already has", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [company("c1"), company("c2")],
          notes: [],
        }),
        findPeople: async () => [person("p1", "c1"), person("p2", "c2")],
        existingPersonIds: async () => new Set(["p1"]),
      }),
      { icp },
    );
    expect(result.leads.map((lead) => lead.personId)).toEqual(["p2"]);
    expect(result.alreadyKnown).toBe(1);
  });

  it("returns the best leads first", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [
            company("c1", { caen: "9999", county: undefined }),
            company("c2", { caen: "6201", county: "Cluj" }),
          ],
          notes: [],
        }),
        findPeople: async () => [person("p1", "c1"), person("p2", "c2")],
      }),
      { icp },
    );
    const scores = result.leads.map((lead) => lead.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("scores every lead and records why", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({ companies: [company("c1")], notes: [] }),
        findPeople: async () => [person("p1", "c1")],
      }),
      { icp },
    );
    const [lead] = result.leads;
    expect(lead.score).toBeGreaterThanOrEqual(0);
    expect(lead.score).toBeLessThanOrEqual(100);
    expect(lead.breakdown.icpFit.reasons.length).toBeGreaterThan(0);
    expect(lead.sourceQuery).toBe("CAEN 6201");
  });

  it("caches the compliance region so the send rules resolve without a join", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({ companies: [company("c1")], notes: [] }),
        findPeople: async () => [person("p1", "c1")],
      }),
      { icp },
    );
    // Romania requires prior consent; the send guard must not need a join to
    // find that out.
    expect(result.leads[0].complianceRegion).toBe("RO");
  });

  it("passes the adapter's own notes through", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [company("c1")],
          notes: ["Search was widened to divisions 62."],
        }),
        findPeople: async () => [person("p1", "c1")],
      }),
      { icp },
    );
    expect(result.notes).toContain("Search was widened to divisions 62.");
  });

  it("carries the cursor so the caller can continue", async () => {
    const result = await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [company("c1")],
          cursor: "c1",
          notes: [],
        }),
        findPeople: async () => [person("p1", "c1")],
      }),
      { icp },
    );
    expect(result.cursor).toBe("c1");
  });

  it("asks for people once, not once per company", async () => {
    // `limit` round trips instead of one is the difference between a run that
    // finishes inside a request and one that does not.
    let calls = 0;
    await sourceRun(
      deps({
        findCompanies: async () => ({
          companies: [company("c1"), company("c2"), company("c3")],
          notes: [],
        }),
        findPeople: async () => {
          calls += 1;
          return [person("p1", "c1")];
        },
      }),
      { icp },
    );
    expect(calls).toBe(1);
  });
});
