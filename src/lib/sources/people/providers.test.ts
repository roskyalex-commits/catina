import { afterEach, describe, expect, it, vi } from "vitest";
import { HunterProvider } from "./hunter";
import { PdlProvider } from "./pdl";
import { ProspeoProvider } from "./prospeo";
import { ApifyProvider } from "./apify";
import { allPeopleProviders, configuredPeopleProviders } from "./registry";

/**
 * Provider adapters, tested against recorded response shapes.
 *
 * No live calls were possible when these were written, so what these tests pin
 * is the behaviour that decides whether the spike's numbers can be trusted:
 * that a provider without a key reports "unconfigured" rather than "zero
 * coverage", that a gated API reports itself gated, and that role addresses
 * are not counted as people.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("HunterProvider", () => {
  const hunterPayload = {
    data: {
      domain: "smartbill.ro",
      organization: "SmartBill",
      emails: [
        {
          value: "ana.pop@smartbill.ro",
          type: "personal",
          confidence: 94,
          first_name: "Ana",
          last_name: "Pop",
          position: "Director General",
          department: "executive",
          linkedin: "https://linkedin.com/in/anapop",
        },
        {
          value: "office@smartbill.ro",
          type: "generic",
          confidence: 88,
          first_name: null,
          last_name: null,
          position: null,
        },
        {
          value: "mihai.ionescu@smartbill.ro",
          type: "personal",
          confidence: 72,
          first_name: "Mihai",
          last_name: "Ionescu",
          position: "Software Engineer",
        },
      ],
    },
    meta: { results: 3 },
  };

  it("maps people and normalises confidence to 0-1", async () => {
    stubFetch(() => jsonResponse(hunterPayload));
    const people = await new HunterProvider("k").findPeople({
      domain: "smartbill.ro",
      limit: 10,
    });

    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({
      fullName: "Ana Pop",
      title: "Director General",
      seniority: "c_level",
      email: "ana.pop@smartbill.ro",
      emailConfidence: 0.94,
      provider: "hunter",
    });
  });

  it("excludes generic role addresses from people coverage", async () => {
    // office@ is a real contact route but not a person. Counting it would
    // inflate the spike's coverage number and hide a genuine gap.
    stubFetch(() => jsonResponse(hunterPayload));
    const people = await new HunterProvider("k").findPeople({
      domain: "smartbill.ro",
      limit: 10,
    });

    expect(people.map((p) => p.email)).not.toContain("office@smartbill.ro");
  });

  it("reports quota from the account endpoint", async () => {
    stubFetch(() =>
      jsonResponse({
        data: { plan_name: "Free", requests: { searches: { used: 3, available: 25 } } },
      }),
    );

    const probe = await new HunterProvider("k").probe();
    expect(probe).toMatchObject({
      configured: true,
      apiAccessible: true,
      planName: "Free",
      quota: { used: 3, limit: 25, remaining: 22 },
    });
  });

  it("reports unconfigured rather than inaccessible when no key is set", async () => {
    // The spike must distinguish "we never had a key" from "we tested it and
    // it was thin" — collapsing those recommends a crawler we may not need.
    const probe = await new HunterProvider(undefined).probe();
    expect(probe).toMatchObject({ configured: false, apiAccessible: false });
    expect(probe.error).toBeUndefined();
  });

  it("reports an API-gated key as configured but inaccessible", async () => {
    // The Apollo-shaped finding: a valid account with no API entitlement.
    stubFetch(() =>
      new Response("API access requires a paid plan", { status: 403 }),
    );

    const probe = await new HunterProvider("k").probe();
    expect(probe.configured).toBe(true);
    expect(probe.apiAccessible).toBe(false);
    expect(probe.error).toMatch(/403/);
  });

  it("handles a domain with no results", async () => {
    stubFetch(() => jsonResponse({ data: { domain: "x.ro", emails: [] } }));
    const people = await new HunterProvider("k").findPeople({
      domain: "x.ro",
      limit: 10,
    });
    expect(people).toEqual([]);
  });

  it("respects the requested limit", async () => {
    stubFetch(() =>
      jsonResponse({
        data: {
          emails: Array.from({ length: 20 }, (_, i) => ({
            value: `p${i}@x.ro`,
            type: "personal",
            first_name: "P",
            last_name: String(i),
            position: "CEO",
          })),
        },
      }),
    );

    const people = await new HunterProvider("k").findPeople({
      domain: "x.ro",
      limit: 5,
    });
    expect(people).toHaveLength(5);
  });
});

describe("ProspeoProvider", () => {
  it("maps the email_list payload", async () => {
    stubFetch(() =>
      jsonResponse({
        error: false,
        response: {
          email_list: [
            {
              email: "radu@gomag.ro",
              first_name: "Radu",
              last_name: "Stan",
              job_title: "Fondator",
              email_status: "VALID",
              linkedin_url: "https://linkedin.com/in/radustan",
            },
          ],
        },
      }),
    );

    const [person] = await new ProspeoProvider("k").findPeople({
      domain: "gomag.ro",
      limit: 10,
    });

    expect(person).toMatchObject({
      fullName: "Radu Stan",
      title: "Fondator",
      seniority: "founder",
      emailConfidence: 0.95,
    });
  });

  it("throws when the provider flags an error in a 200 body", async () => {
    // Prospeo signals failure in-band; treating that as an empty result would
    // silently report zero coverage.
    stubFetch(() => jsonResponse({ error: true, message: "insufficient credits" }));

    await expect(
      new ProspeoProvider("k").findPeople({ domain: "x.ro", limit: 5 }),
    ).rejects.toThrow(/insufficient credits/);
  });

  it("derives first and last name when only a full name is returned", async () => {
    stubFetch(() =>
      jsonResponse({
        error: false,
        response: { email_list: [{ full_name: "Ioana Marin", job_title: "CEO" }] },
      }),
    );

    const [person] = await new ProspeoProvider("k").findPeople({
      domain: "x.ro",
      limit: 5,
    });
    expect(person).toMatchObject({ firstName: "Ioana", lastName: "Marin" });
  });
});

describe("PdlProvider", () => {
  it("maps person records and normalises bare LinkedIn paths", async () => {
    stubFetch(() =>
      jsonResponse({
        status: 200,
        total: 1,
        data: [
          {
            full_name: "Elena Radu",
            first_name: "Elena",
            last_name: "Radu",
            job_title: "Chief Marketing Officer",
            linkedin_url: "linkedin.com/in/elenaradu",
            location_name: "Bucharest, Romania",
          },
        ],
      }),
    );

    const [person] = await new PdlProvider("k").findPeople({
      domain: "x.ro",
      limit: 10,
    });

    expect(person).toMatchObject({
      fullName: "Elena Radu",
      seniority: "c_level",
      linkedinUrl: "https://linkedin.com/in/elenaradu",
      location: "Bucharest, Romania",
    });
  });

  it("leaves email undefined — PDL does not return verified addresses on free tiers", async () => {
    // Recording this in a test because it is the reason a PDL win still needs
    // the Phase 3 waterfall on top.
    stubFetch(() =>
      jsonResponse({ status: 200, data: [{ full_name: "A B", job_title: "CEO" }] }),
    );

    const [person] = await new PdlProvider("k").findPeople({
      domain: "x.ro",
      limit: 10,
    });
    expect(person.email).toBeUndefined();
  });

  it("throws when the search is rejected in-band", async () => {
    stubFetch(() =>
      jsonResponse({ status: 402, data: [], error: { type: "payment_required" } }),
    );

    await expect(
      new PdlProvider("k").findPeople({ domain: "x.ro", limit: 5 }),
    ).rejects.toThrow(/payment_required/);
  });
});

describe("ApifyProvider", () => {
  it("maps a dataset array across common actor key spellings", async () => {
    // Actors each invent their own field names; the adapter must not depend
    // on one actor's choices.
    stubFetch(() =>
      jsonResponse([
        { fullName: "Ana Pop", jobTitle: "Director General", profileUrl: "https://linkedin.com/in/ap" },
        { name: "Mihai Ionescu", headline: "VP Sales", url: "https://linkedin.com/in/mi" },
        { firstName: "Elena", lastName: "Radu", position: "CTO" },
      ]),
    );

    const people = await new ApifyProvider("t", "actor").findPeople({
      domain: "x.ro",
      limit: 10,
    });

    expect(people.map((p) => p.seniority)).toEqual(["c_level", "vp", "c_level"]);
    expect(people[0].linkedinUrl).toBe("https://linkedin.com/in/ap");
  });

  it("errors clearly when the actor returns a non-array", async () => {
    stubFetch(() => jsonResponse({ error: "actor failed" }));

    await expect(
      new ApifyProvider("t", "actor").findPeople({ domain: "x.ro", limit: 5 }),
    ).rejects.toThrow(/expected a dataset array/);
  });

  it("flags a valid token with no actor chosen", async () => {
    // Operator decision, not a failure — say so rather than reporting a
    // bare error the operator can't act on.
    stubFetch(() => jsonResponse({ data: { username: "me", plan: { id: "FREE" } } }));

    const probe = await new ApifyProvider("t", undefined).probe();
    expect(probe.apiAccessible).toBe(true);
    expect(probe.configured).toBe(false);
    expect(probe.error).toMatch(/APIFY_PEOPLE_ACTOR/);
  });

  it("skips dataset items with no usable name", async () => {
    stubFetch(() => jsonResponse([{ jobTitle: "CEO" }, { name: "Real Person" }]));

    const people = await new ApifyProvider("t", "actor").findPeople({
      domain: "x.ro",
      limit: 10,
    });
    expect(people.map((p) => p.fullName)).toEqual(["Real Person"]);
  });
});

describe("provider registry", () => {
  it("returns every provider so the report can distinguish untested from thin", () => {
    expect(allPeopleProviders({}).map((p) => p.key)).toEqual([
      "hunter",
      "prospeo",
      "pdl",
      "apify",
    ]);
  });

  it("filters to configured providers only", () => {
    const configured = configuredPeopleProviders({ HUNTER_API_KEY: "k" });
    expect(configured.map((p) => p.key)).toEqual(["hunter"]);
  });

  it("treats Apify as unconfigured without an actor", () => {
    expect(configuredPeopleProviders({ APIFY_TOKEN: "t" })).toHaveLength(0);
    expect(
      configuredPeopleProviders({ APIFY_TOKEN: "t", APIFY_PEOPLE_ACTOR: "a" }),
    ).toHaveLength(1);
  });

  it("omits Apollo entirely — no API on any free tier", () => {
    expect(allPeopleProviders({}).map((p) => p.key)).not.toContain("apollo");
  });
});
