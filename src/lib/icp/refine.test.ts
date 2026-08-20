import { describe, expect, it } from "vitest";
import { naceCodesFor } from "./industries";
import { applyRefinement, refineIcpFromRejections, type RejectedLead } from "./refine";
import { normaliseIcpIndustries } from "./normalise-industries";
import { icpSchema, type Icp } from "./schema";

/**
 * The behaviour that matters most here is the *absence* of a suggestion.
 *
 * A refiner that always finds something is worse than none: the user learns
 * that the chips are noise and stops reading them, which costs the feature its
 * only purpose. So the cases below spend as much effort on "five rejections
 * that share nothing produce nothing" as on the rules firing.
 */

function icp(overrides: Partial<Icp> = {}): Icp {
  return icpSchema.parse({
    valueProp: "Invoicing software for Romanian SMBs.",
    targetTitles: ["Director General"],
    industryKeys: ["software", "marketing_agency"],
    caenCodes: naceCodesFor(["software", "marketing_agency"]),
    employeeMin: 10,
    employeeMax: 200,
    ...overrides,
  });
}

/** 7311 is advertising; 6210 is custom software under CAEN 2025. */
function reject(overrides: Partial<RejectedLead> = {}): RejectedLead {
  return { companyName: "GENERIC NAME SRL", caen: "6210", ...overrides };
}

describe("suggesting nothing", () => {
  it("says nothing below three rejections", () => {
    const rejects = [
      reject({ companyName: "ALPHA ADS SRL", caen: "7311" }),
      reject({ companyName: "BETA ADS SRL", caen: "7311" }),
    ];
    expect(refineIcpFromRejections(icp(), rejects)).toEqual([]);
  });

  it("says nothing when five rejections share nothing", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "6210", employeeCount: 12 }),
      reject({ companyName: "BRAVO SRL", caen: "7311", employeeCount: 190 }),
      reject({ companyName: "CHARLIE SRL", caen: "6210", employeeCount: 40 }),
      reject({ companyName: "DELTA SRL", caen: "7311", employeeCount: 150 }),
      // Healthcare, which this ICP never targeted, so nothing reaches 3 of 5.
      reject({ companyName: "ECHO SRL", caen: "8690", employeeCount: 90 }),
    ];
    expect(refineIcpFromRejections(icp(), rejects)).toEqual([]);
  });

  it("does not treat a legal form as a shared word", () => {
    // "SRL" is in 5 of 5 Romanian company names, always. Without the stopword
    // list this rule would fire on every reject set in the country.
    const rejects = [
      reject({ companyName: "ALPHA SRL" }),
      reject({ companyName: "BRAVO SRL" }),
      reject({ companyName: "CHARLIE SRL" }),
    ];
    const exclusions = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "add_exclusion",
    );
    expect(exclusions).toEqual([]);
  });

  it("never offers to drop the only industry left", () => {
    // Dropping it would target nothing at all, which is not a refinement.
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "6210" }),
      reject({ companyName: "BRAVO SRL", caen: "6210" }),
      reject({ companyName: "CHARLIE SRL", caen: "6210" }),
    ];
    const single = icp({ industryKeys: ["software"] });
    expect(refineIcpFromRejections(single, rejects)).toEqual([]);
  });

  it("does not offer to drop an industry the ICP never targeted", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "8690" }),
      reject({ companyName: "BRAVO SRL", caen: "8690" }),
      reject({ companyName: "CHARLIE SRL", caen: "8690" }),
    ];
    const suggestions = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "drop_industry",
    );
    expect(suggestions).toEqual([]);
  });
});

describe("dropping an industry", () => {
  it("fires when most rejections share one, and says how many", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "7311" }),
      reject({ companyName: "BRAVO SRL", caen: "7311" }),
      reject({ companyName: "CHARLIE SRL", caen: "7311" }),
      reject({ companyName: "DELTA SRL", caen: "6210" }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects);

    expect(suggestion.kind).toBe("drop_industry");
    expect(suggestion.label).toContain("Marketing");
    // The count is what makes the chip safe to offer rather than apply.
    expect(suggestion.reason).toContain("3 of 4");
  });

  it("recomputes codes from what remains rather than subtracting", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "7311" }),
      reject({ companyName: "BRAVO SRL", caen: "7311" }),
      reject({ companyName: "CHARLIE SRL", caen: "7311" }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects);
    const next = applyRefinement(icp(), suggestion);

    expect(next.industryKeys).toEqual(["software"]);
    // Subtracting the dropped industry's codes would strip anything two
    // industries share and quietly narrow one the user never touched.
    expect(next.caenCodes).toEqual(naceCodesFor(["software"]));
  });

  it("leaves an overridden code list alone", () => {
    const pinned = icp({ caenCodes: ["6210"], caenCodesOverridden: true });
    const rejects = [
      reject({ companyName: "ALPHA SRL", caen: "7311" }),
      reject({ companyName: "BRAVO SRL", caen: "7311" }),
      reject({ companyName: "CHARLIE SRL", caen: "7311" }),
    ];
    const [suggestion] = refineIcpFromRejections(pinned, rejects);

    expect(applyRefinement(pinned, suggestion).caenCodes).toEqual(["6210"]);
  });
});

describe("excluding a shared word", () => {
  it("fires on a distinctive token most rejections share", () => {
    const rejects = [
      reject({ companyName: "PANIFICATIE ALPHA SRL" }),
      reject({ companyName: "PANIFICATIE BRAVO SRL" }),
      reject({ companyName: "PANIFICATIE CHARLIE SRL" }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "add_exclusion",
    );
    expect(suggestion.term).toBe("panificatie");
  });

  it("ignores diacritics so one spelling does not hide the pattern", () => {
    const rejects = [
      reject({ companyName: "CONSTRUCȚII ALPHA SRL" }),
      reject({ companyName: "CONSTRUCTII BRAVO SRL" }),
      reject({ companyName: "Construcţii Charlie SRL" }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "add_exclusion",
    );
    expect(suggestion.term).toBe("constructii");
  });

  it("does not re-suggest an exclusion already in the ICP", () => {
    const rejects = [
      reject({ companyName: "PANIFICATIE ALPHA SRL" }),
      reject({ companyName: "PANIFICATIE BRAVO SRL" }),
      reject({ companyName: "PANIFICATIE CHARLIE SRL" }),
    ];
    const already = icp({ exclusions: ["panificatie"] });
    expect(
      refineIcpFromRejections(already, rejects).filter((r) => r.kind === "add_exclusion"),
    ).toEqual([]);
  });

  it("appends rather than replacing when applied", () => {
    const base = icp({ exclusions: ["gambling"] });
    const next = applyRefinement(base, {
      kind: "add_exclusion",
      term: "panificatie",
      label: "",
      reason: "",
    });
    expect(next.exclusions).toEqual(["gambling", "panificatie"]);
  });
});

describe("narrowing the size band", () => {
  it("raises the minimum when every rejection was smaller", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", employeeCount: 12 }),
      reject({ companyName: "BRAVO SRL", employeeCount: 15 }),
      reject({ companyName: "CHARLIE SRL", employeeCount: 20 }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "narrow_employees",
    );

    expect(suggestion.min).toBe(21);
    expect(suggestion.max).toBe(200);
  });

  it("lowers the maximum when every rejection was larger", () => {
    const rejects = [
      reject({ companyName: "ALPHA SRL", employeeCount: 180 }),
      reject({ companyName: "BRAVO SRL", employeeCount: 150 }),
      reject({ companyName: "CHARLIE SRL", employeeCount: 190 }),
    ];
    const [suggestion] = refineIcpFromRejections(icp(), rejects).filter(
      (r) => r.kind === "narrow_employees",
    );

    expect(suggestion.max).toBe(149);
    expect(suggestion.min).toBe(10);
  });

  it("says nothing when the sizes straddle the band", () => {
    // A spread of sizes means size was not the problem, and inventing a bound
    // from it narrows the search for no reason.
    const rejects = [
      reject({ companyName: "ALPHA SRL", employeeCount: 12 }),
      reject({ companyName: "BRAVO SRL", employeeCount: 180 }),
      reject({ companyName: "CHARLIE SRL", employeeCount: 20 }),
    ];
    expect(
      refineIcpFromRejections(icp(), rejects).filter((r) => r.kind === "narrow_employees"),
    ).toEqual([]);
  });

  it("says nothing when the ICP has no upper bound to reason about", () => {
    const open = icp({ employeeMax: null });
    const rejects = [
      reject({ companyName: "ALPHA SRL", employeeCount: 12 }),
      reject({ companyName: "BRAVO SRL", employeeCount: 15 }),
      reject({ companyName: "CHARLIE SRL", employeeCount: 20 }),
    ];
    expect(
      refineIcpFromRejections(open, rejects).filter((r) => r.kind === "narrow_employees"),
    ).toEqual([]);
  });
});

describe("applying a refinement", () => {
  it("never mutates the ICP it was given", () => {
    const base = icp();
    const snapshot = JSON.parse(JSON.stringify(base));
    applyRefinement(base, { kind: "add_exclusion", term: "x", label: "", reason: "" });
    expect(base).toEqual(snapshot);
  });

  it("respects the code ceiling when dropping from a truncated ICP", () => {
    /*
     * Caught in the browser, not by a test. Six broad industries derive past
     * the 60-code cap and get truncated to 60. Dropping one of them then
     * recomputed from scratch and produced **77** — more codes than before, and
     * past a ceiling `icpSchema` enforces at `.max(60)`, so the wizard posted an
     * agent the API refused with a validation error.
     */
    const broad = icp({
      industryKeys: [
        "ecommerce",
        "retail",
        "wholesale",
        "accounting_legal",
        "financial_services",
        "business_support",
      ],
      industries: [],
    });
    const normalised = normaliseIcpIndustries(broad).icp;
    expect(normalised.caenCodes).toHaveLength(60);

    const next = applyRefinement(normalised, {
      kind: "drop_industry",
      industryKey: "wholesale",
      codes: naceCodesFor(["wholesale"]),
      label: "",
      reason: "",
    });

    expect(next.industryKeys).not.toContain("wholesale");
    expect(next.caenCodes.length).toBeLessThanOrEqual(60);
    expect(icpSchema.safeParse(next).success).toBe(true);
  });

  it("leaves the result valid against the schema", () => {
    const rejects = [
      reject({ companyName: "PANIFICATIE ALPHA SRL", caen: "7311", employeeCount: 12 }),
      reject({ companyName: "PANIFICATIE BRAVO SRL", caen: "7311", employeeCount: 15 }),
      reject({ companyName: "PANIFICATIE CHARLIE SRL", caen: "7311", employeeCount: 20 }),
    ];

    let next = icp();
    for (const suggestion of refineIcpFromRejections(next, rejects)) {
      next = applyRefinement(next, suggestion);
    }
    expect(icpSchema.safeParse(next).success).toBe(true);
  });
});
