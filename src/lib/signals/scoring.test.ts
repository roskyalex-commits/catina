import { describe, expect, it } from "vitest";
import {
  rescoreWithEmail,
  rescoreWithSignals,
  scoreLead,
  summariseScore,
  type ScoreBreakdown,
  type ScoreInput,
} from "./scoring";
import type { Signal } from "./types";
import type { Icp } from "@/lib/icp/schema";
import type { SourcedCompany } from "@/lib/sources/types";

/**
 * Scoring decides the order of the lead list, which is the whole product
 * surface. These tests pin the judgements that ordering depends on: that a
 * disqualifier beats a great score, that stale signals fade, that many weak
 * signals don't outrank one decisive one, and that an unverified email is
 * clearly worth less than a verified one.
 */

const icp: Icp = {
  valueProp: "Invoicing software for Romanian SMBs.",
  targetTitles: ["Director General", "CEO"],
  targetSeniorities: ["founder", "c_level"],
  industries: ["Software"],
  caenCodes: ["6201", "6202"],
  companyTypes: ["smb"],
  countries: ["RO"],
  keywords: ["facturare"],
  exclusions: ["Competitor Ltd"],
  employeeMin: 10,
  employeeMax: 200,
  revenueMinRon: null,
  revenueMaxRon: null,
  confidence: 0.9,
  assumptions: [],
};

const company: SourcedCompany = {
  dedupeKey: "firma.ro",
  name: "Firma Test SRL",
  domain: "firma.ro",
  country: "RO",
  caen: "6201",
  cui: "12345678",
  employeesAnaf: 45,
  vatRegistered: true,
  insolvencyStatus: null,
  source: "anaf",
};

const person = { fullName: "Ana Popescu", title: "Director General" };

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "hiring_buyer_role",
    title: "Hiring a Marketing Director",
    strength: 0.9,
    detectedAt: new Date(),
    dedupeKey: "x",
    ...overrides,
  };
}

function base(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    icp,
    company,
    person,
    email: { status: "verified", confidence: 0.95, isRoleAddress: false },
    now: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("scoreLead — disqualifiers", () => {
  it("zeroes an insolvent company however good the fit", () => {
    // An insolvent company is not a lead at any fit level.
    const result = scoreLead(
      base({
        company: { ...company, insolvencyStatus: "anaf_inactive" },
        signals: [signal()],
      }),
    );

    expect(result.total).toBe(0);
    expect(result.disqualified).toMatch(/inactive taxpayer/i);
  });

  it("zeroes a suppressed lead", () => {
    const result = scoreLead(base({ suppressed: true }));
    expect(result.total).toBe(0);
    expect(result.disqualified).toMatch(/do-not-contact/i);
  });

  it("zeroes a lead whose email previously bounced", () => {
    const result = scoreLead(
      base({ email: { status: "bounced", confidence: 0, isRoleAddress: false } }),
    );
    expect(result.total).toBe(0);
  });

  it("zeroes a company matching an exclusion", () => {
    const result = scoreLead(
      base({ company: { ...company, name: "Competitor Ltd Romania" } }),
    );
    expect(result.disqualified).toMatch(/Competitor Ltd/);
  });

  it("scores an ordinary lead well above zero", () => {
    // Guards against a disqualifier rule matching everything.
    expect(scoreLead(base({ signals: [signal()] })).total).toBeGreaterThan(60);
  });
});

describe("scoreLead — ICP fit", () => {
  it("rewards an exact title match", () => {
    const strong = scoreLead(base());
    const weak = scoreLead(base({ person: { fullName: "X", title: "Intern" } }));
    expect(strong.icpFit.score).toBeGreaterThan(weak.icpFit.score);
  });

  it("scores a same-division CAEN below an exact code match", () => {
    // 6209 is adjacent to 6201, not the same business.
    const exact = scoreLead(base({ company: { ...company, caen: "6201" } }));
    const division = scoreLead(base({ company: { ...company, caen: "6209" } }));
    const off = scoreLead(base({ company: { ...company, caen: "4711" } }));

    expect(exact.icpFit.score).toBeGreaterThan(division.icpFit.score);
    expect(division.icpFit.score).toBeGreaterThan(off.icpFit.score);
  });

  it("penalises headcount outside the range", () => {
    const inRange = scoreLead(base({ company: { ...company, employeesAnaf: 45 } }));
    const tooBig = scoreLead(base({ company: { ...company, employeesAnaf: 5000 } }));
    expect(inRange.icpFit.score).toBeGreaterThan(tooBig.icpFit.score);
  });

  it("treats an ICP with no criteria as neutral, not as a bad fit", () => {
    // Scoring an unknown as zero would bury every lead for a loose ICP.
    const loose: Icp = {
      ...icp,
      caenCodes: [],
      countries: [],
      employeeMin: null,
      employeeMax: null,
    };
    const result = scoreLead(base({ icp: loose, person: undefined }));
    expect(result.icpFit.score).toBe(0.5);
  });

  it("scores on the company alone when no person is known", () => {
    const result = scoreLead(base({ person: undefined }));
    expect(result.icpFit.score).toBeGreaterThan(0.9);
  });
});

describe("scoreLead — signals", () => {
  it("ranks a lead with signals above an identical one without", () => {
    const withSignal = scoreLead(base({ signals: [signal()] }));
    const without = scoreLead(base({ signals: [] }));
    expect(withSignal.total).toBeGreaterThan(without.total);
  });

  it("decays a stale signal", () => {
    // A 30-day half-life means a 90-day-old hiring post is worth ~1/8.
    const fresh = scoreLead(
      base({ signals: [signal({ detectedAt: new Date("2026-06-01T00:00:00Z") })] }),
    );
    const stale = scoreLead(
      base({ signals: [signal({ detectedAt: new Date("2026-03-01T00:00:00Z") })] }),
    );
    expect(fresh.signals.score).toBeGreaterThan(stale.signals.score * 2);
  });

  it("decays an annual filing far more slowly than a job posting", () => {
    // The whole point of per-type half-lives: a filing is the freshest fact
    // available for months, and fast decay would discard our best signal.
    const at = new Date("2026-01-01T00:00:00Z");
    const filing = scoreLead(
      base({
        signals: [
          signal({ type: "anaf_revenue_growth", title: "Revenue up 40%", detectedAt: at }),
        ],
      }),
    );
    const posting = scoreLead(base({ signals: [signal({ detectedAt: at })] }));

    expect(filing.signals.score).toBeGreaterThan(posting.signals.score);
  });

  it("applies diminishing returns to many weak signals", () => {
    // One decisive signal should beat a pile of weak ones.
    const many = scoreLead(
      base({
        signals: Array.from({ length: 8 }, (_, i) =>
          signal({ strength: 0.2, dedupeKey: `s${i}` }),
        ),
      }),
    );
    const one = scoreLead(base({ signals: [signal({ strength: 0.95 })] }));

    expect(many.signals.score).toBeLessThan(1);
    expect(one.signals.score).toBeGreaterThan(0.4);
  });

  it("counts a negative signal as a penalty, not as signal strength", () => {
    const result = scoreLead(
      base({
        signals: [
          signal({ type: "anaf_revenue_decline", title: "Revenue down 30%", strength: 0.8 }),
        ],
      }),
    );

    expect(result.penalties.total).toBeLessThan(0);
    expect(result.signals.score).toBe(0);
  });

  it("does not let a stale negative cancel a fresh positive", () => {
    const result = scoreLead(
      base({
        signals: [
          signal({ strength: 0.95 }),
          signal({
            type: "anaf_revenue_decline",
            title: "Revenue down",
            strength: 0.8,
            detectedAt: new Date("2024-01-01T00:00:00Z"),
          }),
        ],
      }),
    );
    expect(result.total).toBeGreaterThan(50);
  });
});

describe("scoreLead — contactability", () => {
  it("ranks verified above pattern-guessed by a wide margin", () => {
    // This gap is what decides whether outreach can be automated.
    const verified = scoreLead(
      base({ email: { status: "verified", confidence: 0.95, isRoleAddress: false } }),
    );
    const guessed = scoreLead(
      base({ email: { status: "pattern", confidence: 0.35, isRoleAddress: false } }),
    );

    expect(verified.contactability.score).toBeGreaterThan(
      guessed.contactability.score * 2,
    );
  });

  it("discounts a role address", () => {
    const personal = scoreLead(
      base({ email: { status: "found", confidence: 0.8, isRoleAddress: false } }),
    );
    const role = scoreLead(
      base({ email: { status: "found", confidence: 0.8, isRoleAddress: true } }),
    );
    expect(role.contactability.score).toBeLessThan(personal.contactability.score);
  });

  it("scores zero contactability with no email", () => {
    const result = scoreLead(base({ email: undefined }));
    expect(result.contactability.score).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  });
});

describe("scoreLead — breakdown", () => {
  it("explains every component", () => {
    // The breakdown is the product feature; an unexplained score isn't trusted.
    const result = scoreLead(base({ signals: [signal()] }));

    expect(result.icpFit.reasons.length).toBeGreaterThan(0);
    expect(result.signals.reasons.length).toBeGreaterThan(0);
    expect(result.contactability.reasons.length).toBeGreaterThan(0);
    expect(result.icpFit.weight + result.signals.weight + result.contactability.weight)
      .toBeCloseTo(1);
  });

  it("orders signal reasons strongest first", () => {
    const result = scoreLead(
      base({
        signals: [
          signal({ strength: 0.3, title: "Weak", dedupeKey: "a" }),
          signal({ strength: 0.95, title: "Strong", dedupeKey: "b" }),
        ],
      }),
    );
    expect(result.signals.reasons[0].label).toContain("Strong");
  });

  it("describes signal age in the reason", () => {
    const result = scoreLead(
      base({ signals: [signal({ detectedAt: new Date("2026-05-31T00:00:00Z") })] }),
    );
    expect(result.signals.reasons[0].label).toContain("yesterday");
  });

  it("keeps the total within 0-100", () => {
    const maxed = scoreLead(
      base({
        signals: Array.from({ length: 20 }, (_, i) =>
          signal({ strength: 1, dedupeKey: `s${i}` }),
        ),
      }),
    );
    expect(maxed.total).toBeGreaterThanOrEqual(0);
    expect(maxed.total).toBeLessThanOrEqual(100);
  });
});

describe("summariseScore", () => {
  it("leads with the disqualifier when there is one", () => {
    const result = scoreLead(base({ suppressed: true }));
    expect(summariseScore(result)).toMatch(/do-not-contact/i);
  });

  it("leads with the strongest signal", () => {
    const result = scoreLead(
      base({ signals: [signal({ title: "Hiring a Marketing Director" })] }),
    );
    expect(summariseScore(result)).toContain("Hiring a Marketing Director");
  });

  it("falls back to a fit reason when there are no signals", () => {
    const result = scoreLead(base({ signals: [] }));
    expect(summariseScore(result)).toBeTruthy();
    expect(summariseScore(result)).not.toContain("undefined");
  });
});

describe("rescoreWithEmail", () => {
  /** A lead as sourcing leaves it: good fit, no signals, no address. */
  const at45: ScoreBreakdown = {
    total: 45,
    icpFit: { score: 1, weight: 0.45, reasons: [{ label: "Target title", points: 1 }] },
    signals: { score: 0, weight: 0.35, reasons: [] },
    contactability: { score: 0, weight: 0.2, reasons: [] },
    penalties: { total: 0, reasons: [] },
  };

  it("lifts a lead off the no-email ceiling", () => {
    const after = rescoreWithEmail(at45, {
      status: "found",
      confidence: 0.55,
      isRoleAddress: true,
    });

    expect(at45.total).toBe(45);
    expect(after.total).toBeGreaterThan(45);
  });

  it("scores a personal address above a role address", () => {
    const role = rescoreWithEmail(at45, {
      status: "found",
      confidence: 0.55,
      isRoleAddress: true,
    });
    const personal = rescoreWithEmail(at45, {
      status: "found",
      confidence: 0.55,
      isRoleAddress: false,
    });

    expect(personal.total).toBeGreaterThan(role.total);
  });

  it("agrees with scoreLead rather than reimplementing it", () => {
    const email = { status: "found" as const, confidence: 0.55, isRoleAddress: true };
    const full = scoreLead(base({ email }));

    // Same email, same weights: the shortcut must land on the same
    // contactability the full scorer would compute.
    expect(rescoreWithEmail(at45, email).contactability.score).toBeCloseTo(
      full.contactability.score,
      10,
    );
  });

  it("carries a non-email disqualifier through untouched", () => {
    const insolvent: ScoreBreakdown = { ...at45, total: 0, disqualified: "Insolvency proceedings on record" };

    const after = rescoreWithEmail(insolvent, {
      status: "verified",
      confidence: 0.95,
      isRoleAddress: false,
    });

    // Finding an address does not make an insolvent company a lead.
    expect(after.disqualified).toBe("Insolvency proceedings on record");
    expect(after.total).toBe(0);
  });

  it("drops its own stale verdict when a later run finds a good address", () => {
    const bounced: ScoreBreakdown = { ...at45, total: 0, disqualified: "Previous email bounced" };

    const after = rescoreWithEmail(bounced, {
      status: "verified",
      confidence: 0.95,
      isRoleAddress: false,
    });

    // Inheriting it would leave the lead dead forever on the strength of an
    // address it no longer uses.
    expect(after.disqualified).toBeUndefined();
    expect(after.total).toBeGreaterThan(45);
  });

  it("disqualifies on an invalid address", () => {
    const after = rescoreWithEmail(at45, {
      status: "invalid",
      confidence: 0.1,
      isRoleAddress: false,
    });

    expect(after.disqualified).toBe("Email address is invalid");
    expect(after.total).toBe(0);
  });

  it("leaves the score where it was when nothing was found", () => {
    expect(rescoreWithEmail(at45, undefined).total).toBe(45);
  });
});

describe("rescoreWithSignals", () => {
  /** A contactable lead as enrichment leaves it: good fit, an email, no signals. */
  const at54: ScoreBreakdown = {
    total: 54,
    icpFit: { score: 1, weight: 0.45, reasons: [{ label: "Target title", points: 1 }] },
    signals: { score: 0, weight: 0.35, reasons: [{ label: "No buying signals detected yet", points: 0 }] },
    contactability: { score: 0.4305, weight: 0.2, reasons: [{ label: "Email found at source", points: 0.75 }] },
    penalties: { total: 0, reasons: [] },
  };

  function hiring(overrides: Partial<Signal> = {}): Signal {
    return {
      type: "hiring_buyer_role",
      title: "Hiring a Marketing Director",
      strength: 0.9,
      detectedAt: new Date(),
      dedupeKey: "h1",
      ...overrides,
    };
  }

  it("lifts a lead off the no-signal score", () => {
    const after = rescoreWithSignals(at54, [hiring()]);

    // 35% of the score was a constant zero until the scanner existed.
    expect(after.total).toBeGreaterThan(54);
    expect(after.signals.score).toBeGreaterThan(0);
  });

  it("leaves fit and contactability exactly as they were", () => {
    const after = rescoreWithSignals(at54, [hiring()]);

    expect(after.icpFit).toEqual(at54.icpFit);
    expect(after.contactability).toEqual(at54.contactability);
  });

  it("agrees with scoreLead rather than reimplementing it", () => {
    const signals = [hiring()];
    const full = scoreLead(base({ signals }));

    expect(rescoreWithSignals(at54, signals).signals.score).toBeCloseTo(
      full.signals.score,
      10,
    );
  });

  it("keeps the VAT penalty, which no signal put there", () => {
    const withVat: ScoreBreakdown = {
      ...at54,
      penalties: { total: -0.05, reasons: [{ label: "Not registered for VAT", points: -0.05 }] },
    };

    const after = rescoreWithSignals(withVat, [hiring()]);
    expect(after.penalties.reasons).toContainEqual({
      label: "Not registered for VAT",
      points: -0.05,
    });
  });

  it("disqualifies on a fresh insolvency signal", () => {
    const after = rescoreWithSignals(at54, [
      hiring({ type: "insolvency_risk", title: "Listed as an inactive taxpayer at ANAF", strength: 1 }),
    ]);

    expect(after.disqualified).toBe("Insolvency proceedings on record");
    expect(after.total).toBe(0);
  });

  it("withdraws its own stale distress verdict when the signal is gone", () => {
    const dead: ScoreBreakdown = {
      ...at54,
      total: 0,
      disqualified: "Insolvency proceedings on record",
    };

    // A company can come off the inactive list. Inheriting the verdict would
    // keep the lead dead forever on the strength of a scan months ago.
    const after = rescoreWithSignals(dead, [hiring()]);
    expect(after.disqualified).toBeUndefined();
    expect(after.total).toBeGreaterThan(54);
  });

  it("does not withdraw a verdict a scan knows nothing about", () => {
    const suppressed: ScoreBreakdown = {
      ...at54,
      total: 0,
      disqualified: "On your do-not-contact list",
    };

    expect(rescoreWithSignals(suppressed, [hiring()]).disqualified).toBe(
      "On your do-not-contact list",
    );
  });

  it("is a no-op on a breakdown that had no signals and still has none", () => {
    expect(rescoreWithSignals(at54, []).total).toBe(54);
  });

  it("decays an old signal towards nothing", () => {
    const fresh = rescoreWithSignals(at54, [hiring()]);
    const old = rescoreWithSignals(at54, [
      hiring({ detectedAt: new Date(Date.now() - 365 * 86_400_000) }),
    ]);

    expect(old.total).toBeLessThan(fresh.total);
  });
});
