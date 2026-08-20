import { describe, expect, it } from "vitest";
import type { SiteSnapshot } from "@/lib/crawl/fetch-site";
import type { SignalScanContext } from "../types";
import { CompetitorMentionSignalSource, CompetitorTechSignalSource } from "./competitor";

/**
 * The claim this file exists to defend: competitor *presence* needs no previous
 * scan, while `TechStackSignalSource` — which reads the same snapshot — cannot
 * fire until a company has been scanned twice. That difference is why both
 * exist, and a refactor that quietly gates this one on `previous` would delete
 * the strongest first-pass signal in the build without failing anything else.
 */

function snapshot(overrides: Partial<SiteSnapshot> = {}): SiteSnapshot {
  return {
    domain: "exemplu.ro",
    origin: "https://exemplu.ro",
    pages: [{ url: "https://exemplu.ro/", title: "t", text: "Bine ati venit." }],
    techStack: [],
    roleEmails: [],
    socialLinks: {},
    ...overrides,
  };
}

function context(overrides: Partial<SignalScanContext> = {}): SignalScanContext {
  return {
    company: { dedupeKey: "cui:1", name: "EXEMPLU SRL", domain: "exemplu.ro", source: "onrc" },
    ...overrides,
  };
}

describe("CompetitorTechSignalSource", () => {
  const source = new CompetitorTechSignalSource();

  it("fires with no previous scan at all", () => {
    expect(source.isApplicable(context({ competitorTech: ["HubSpot"] }))).toBe(true);
  });

  it("does not apply when the agent named no competitors", () => {
    expect(source.isApplicable(context({ competitorTech: [] }))).toBe(false);
  });

  it("reports a competitor detected on the prospect's site today", async () => {
    const signals = await source.scan(
      context({
        competitorTech: ["HubSpot"],
        site: async () => snapshot({ techStack: ["WordPress", "HubSpot"] }),
      }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("competitor_tech");
    expect(signals[0].strength).toBe(0.85);
    expect(signals[0].payload?.competitors).toEqual(["HubSpot"]);
  });

  it("matches whatever casing the ICP stored", async () => {
    const signals = await source.scan(
      context({
        competitorTech: ["hubspot"],
        site: async () => snapshot({ techStack: ["HubSpot"] }),
      }),
    );
    expect(signals).toHaveLength(1);
  });

  it("stays silent about technology the agent did not name", async () => {
    const signals = await source.scan(
      context({
        competitorTech: ["HubSpot"],
        site: async () => snapshot({ techStack: ["WordPress", "Stripe"] }),
      }),
    );
    expect(signals).toEqual([]);
  });

  it("does not scale strength with the number of competitors found", async () => {
    const one = await source.scan(
      context({ competitorTech: ["HubSpot"], site: async () => snapshot({ techStack: ["HubSpot"] }) }),
    );
    const two = await source.scan(
      context({
        competitorTech: ["HubSpot", "Klaviyo"],
        site: async () => snapshot({ techStack: ["HubSpot", "Klaviyo"] }),
      }),
    );

    // One competing product is already decisive; a second does not make the
    // conversation twice as likely.
    expect(two[0].strength).toBe(one[0].strength);
    expect(two[0].dedupeKey).not.toBe(one[0].dedupeKey);
  });
});

describe("CompetitorMentionSignalSource", () => {
  const source = new CompetitorMentionSignalSource();

  it("finds a competitor named in the prospect's own copy, with the sentence", async () => {
    const signals = await source.scan(
      context({
        competitorNames: ["Oblio"],
        site: async () =>
          snapshot({
            pages: [
              {
                url: "https://exemplu.ro/",
                title: "t",
                text: "Migrăm clienții de pe Oblio fără costuri.",
              },
            ],
          }),
      }),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("competitor_mention");
    // Without the snippet a user cannot tell a customer from a reseller from a
    // rival, and the signal would be indefensible.
    const hits = signals[0].payload?.hits as { snippet: string }[];
    expect(hits[0].snippet).toContain("Oblio");
  });

  it("does not let a company match itself", async () => {
    const signals = await source.scan(
      context({
        company: {
          dedupeKey: "cui:1",
          name: "OBLIO SOFTWARE SRL",
          domain: "exemplu.ro",
          source: "onrc",
        },
        competitorNames: ["Oblio"],
        site: async () =>
          snapshot({
            pages: [{ url: "https://exemplu.ro/", title: "t", text: "Oblio este platforma noastră." }],
          }),
      }),
    );

    expect(signals).toEqual([]);
  });

  it("scores below a fingerprinted detection", async () => {
    const mention = await source.scan(
      context({
        competitorNames: ["Oblio"],
        site: async () =>
          snapshot({
            pages: [{ url: "https://exemplu.ro/", title: "t", text: "Am folosit Oblio." }],
          }),
      }),
    );
    const detected = await new CompetitorTechSignalSource().scan(
      context({ competitorTech: ["HubSpot"], site: async () => snapshot({ techStack: ["HubSpot"] }) }),
    );

    expect(mention[0].strength).toBeLessThan(detected[0].strength);
  });
});
