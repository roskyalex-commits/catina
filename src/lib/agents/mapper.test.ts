import { describe, expect, it } from "vitest";
import {
  agentDetailFrom,
  agentInsertFrom,
  agentSummaryFrom,
  emptyChart,
  revenueBandFrom,
} from "./mapper";
import { createAgentSchema, DEFAULT_ENABLED_SIGNALS } from "./schema";

/**
 * These cover the only part of agent persistence that can be exercised without
 * a database: the schema at the boundary and the row mapping either side of
 * PostgREST. Rows here are shaped the way PostgREST actually returns them —
 * snake_case keys, ISO date strings, numerics as strings.
 */

const VALID_INPUT = {
  name: "Romania · Finance & Ops",
  websiteUrl: "https://example.ro",
  valueProp: "We sell bookkeeping automation to Romanian accounting firms.",
  productName: "Ledger",
  targetTitles: ["CEO", "Financial Director"],
  targetSeniorities: ["c_level"],
  industries: ["Accounting"],
  caenCodes: ["6920"],
  companyTypes: ["smb"],
  countries: ["RO"],
  keywords: ["contabilitate"],
  exclusions: ["banks"],
  employeeMin: 5,
  employeeMax: 200,
  revenueMinRon: 500_000,
  revenueMaxRon: null,
  confidence: 0.8,
  assumptions: ["Pricing page did not list tiers."],
  enabledSignals: ["anaf_growth", "hiring"],
};

/** A row as PostgREST returns it, with the selected columns only. */
const ROW: Record<string, unknown> = {
  id: "8f1d2b3c-0000-4000-8000-000000000001",
  name: "Romania · Finance & Ops",
  status: "draft",
  countries: ["RO", "BG"],
  keywords: ["contabilitate"],
  caen_codes: ["6920"],
  target_titles: ["CEO"],
  enabled_signals: ["anaf_growth"],
  next_launch_at: null,
  created_at: "2026-08-18T09:30:00+00:00",
};

describe("createAgentSchema", () => {
  it("accepts the wizard's payload", () => {
    expect(() => createAgentSchema.parse(VALID_INPUT)).not.toThrow();
  });

  it("defaults signals to the free sources when the field is absent", () => {
    const parsed = createAgentSchema.parse({
      ...VALID_INPUT,
      enabledSignals: undefined,
    });
    expect(parsed.enabledSignals).toEqual([...DEFAULT_ENABLED_SIGNALS]);
  });

  it("rejects a signal key that is not in the catalogue", () => {
    // An unknown key would sit in the column and never be scanned.
    const result = createAgentSchema.safeParse({
      ...VALID_INPUT,
      enabledSignals: ["linkedin_engagement"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a blank name", () => {
    expect(
      createAgentSchema.safeParse({ ...VALID_INPUT, name: "   " }).success,
    ).toBe(false);
  });

  it("rejects a CAEN code that is not four digits", () => {
    expect(
      createAgentSchema.safeParse({ ...VALID_INPUT, caenCodes: ["692"] }).success,
    ).toBe(false);
  });
});

describe("agentInsertFrom", () => {
  const input = createAgentSchema.parse(VALID_INPUT);
  const insert = agentInsertFrom(input, "org-1");

  it("takes org_id from the caller, not the body", () => {
    const spoofed = agentInsertFrom(
      { ...input, ...({ orgId: "someone-else" } as object) },
      "org-1",
    );
    expect(spoofed.org_id).toBe("org-1");
  });

  it("maps camelCase fields onto column names", () => {
    expect(insert.website_url).toBe("https://example.ro");
    expect(insert.value_prop).toBe(VALID_INPUT.valueProp);
    expect(insert.caen_codes).toEqual(["6920"]);
    expect(insert.target_seniorities).toEqual(["c_level"]);
    expect(insert.employee_max).toBe(200);
  });

  it("creates every agent as a draft", () => {
    // Activating needs a mailbox and a compliance acknowledgement that this
    // route does not collect.
    expect(insert.status).toBe("draft");
  });

  it("keeps a null revenue bound null rather than sending zero", () => {
    expect(insert.revenue_max_ron).toBeNull();
    expect(insert.revenue_min_ron).toBe(500_000);
  });

  it("stores assumptions as jsonb evidence", () => {
    expect(insert.source_evidence).toEqual({
      assumptions: ["Pricing page did not list tiers."],
    });
  });

  it("writes no id — the database generates it", () => {
    expect(insert.id).toBeUndefined();
  });
});

describe("agentSummaryFrom", () => {
  it("maps a row to the view model", () => {
    const summary = agentSummaryFrom(ROW);
    expect(summary.id).toBe(ROW.id);
    expect(summary.name).toBe("Romania · Finance & Ops");
    expect(summary.status).toBe("draft");
    expect(summary.countries).toEqual(["RO", "BG"]);
    expect(summary.createdAt.toISOString()).toBe("2026-08-18T09:30:00.000Z");
    expect(summary.nextLaunchAt).toBeNull();
  });

  it("reports no mailbox until Gmail OAuth exists", () => {
    expect(agentSummaryFrom(ROW).mailbox).toBeNull();
  });

  it("falls back to draft for an unrecognised status", () => {
    expect(agentSummaryFrom({ ...ROW, status: "archived" }).status).toBe("draft");
  });

  it("throws a fixable error when a required column is missing", () => {
    const withoutName = { ...ROW };
    delete withoutName.name;
    expect(() => agentSummaryFrom(withoutName)).toThrow(/db:types/);
  });

  it("treats a null array column as empty rather than throwing", () => {
    expect(agentSummaryFrom({ ...ROW, countries: null }).countries).toEqual([]);
  });

  it("carries counts through when the caller has them", () => {
    const summary = agentSummaryFrom(ROW, { leadsFound: 12, contacted: 5 });
    expect(summary.leadsFound).toBe(12);
    expect(summary.contacted).toBe(5);
  });

  it("defaults counts to zero", () => {
    expect(agentSummaryFrom(ROW).leadsFound).toBe(0);
  });
});

describe("emptyChart", () => {
  const chart = emptyChart(new Date("2026-08-18T12:00:00Z"));

  it("labels seven days ending today", () => {
    expect(chart.labels).toHaveLength(7);
    expect(chart.labels.at(-1)).toContain("18");
  });

  it("gives every series a full run of zeroes", () => {
    // A flat line, not an empty box: the axis code should still render.
    expect(chart.series).toHaveLength(4);
    for (const series of chart.series) {
      expect(series.points).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect(series.points).toHaveLength(chart.labels.length);
    }
  });

  it("uses CSS variables for colour, never hex", () => {
    for (const series of chart.series) {
      expect(series.color.startsWith("--")).toBe(true);
    }
  });
});

describe("agentDetailFrom", () => {
  const detail = agentDetailFrom(ROW, { leadsFound: 0, contacted: 0 });

  it("reports nothing measured as null, not zero", () => {
    // 0% deliverability would be a claim about mail that never left.
    expect(detail.sendStats.deliverablePct).toBeNull();
    expect(detail.sendStats.bounces).toBeNull();
  });

  it("reports genuine zeroes as zero", () => {
    expect(detail.stats.found).toBe(0);
    expect(detail.sendStats.emailsSent).toBe(0);
    expect(detail.activity).toEqual([]);
    expect(detail.leads).toEqual([]);
  });

  it("surfaces the targeting the agent was created with", () => {
    expect(detail.sources.caenCodes).toEqual(["6920"]);
    expect(detail.sources.enabledSignals).toEqual(["anaf_growth"]);
    expect(detail.sources.targetTitles).toEqual(["CEO"]);
  });

  it("leaves auto-send off and nothing acknowledged", () => {
    expect(detail.campaign.autoSend).toBe(false);
    expect(detail.campaign.complianceAcknowledged).toBe(false);
    expect(detail.campaign.senderEmail).toBeNull();
  });

  it("has nothing pending review before anything is sourced", () => {
    expect(detail.pendingReview).toBeNull();
  });
});

describe("revenueBandFrom", () => {
  it("parses numerics that PostgREST returns as strings", () => {
    const band = revenueBandFrom({
      revenue_min_ron: "500000.00",
      revenue_max_ron: null,
    });
    expect(band.minRon).toBe(500_000);
    expect(band.maxRon).toBeNull();
  });
});
