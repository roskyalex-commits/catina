import { describe, expect, it } from "vitest";
import {
  evaluateCampaign,
  evaluateCompliance,
  jurisdictionFor,
  type ComplianceInput,
} from "./compliance";

/**
 * The premise these tests protect: "GDPR compliance" is not one rule. Whether
 * you may send an unsolicited commercial email is set by each country's
 * ePrivacy implementation, and those differ sharply. A tool that flattens them
 * either over-blocks the permissive markets or quietly exposes the user in the
 * strict ones.
 */

function input(overrides: Partial<ComplianceInput> = {}): ComplianceInput {
  return {
    recipientCountry: "RO",
    recipientEmail: "ana@firma.ro",
    isRoleAddress: false,
    autoSend: false,
    ...overrides,
  };
}

describe("jurisdictionFor", () => {
  it("knows Romania requires prior opt-in with no B2B exemption", () => {
    // The home market, and the differentiator.
    const rule = jurisdictionFor("RO");
    expect(rule.posture).toBe("consent_required");
    expect(rule.statute).toContain("506/2004");
    expect(rule.detail).toMatch(/ANSPDCP/);
  });

  it("knows the UK allows B2B on legitimate interest", () => {
    // The contrast case — flattening these two is the mistake.
    const rule = jurisdictionFor("GB");
    expect(rule.posture).toBe("legitimate_interest");
    expect(rule.statute).toContain("PECR");
  });

  it("classifies Germany and Austria as strict alongside Romania", () => {
    expect(jurisdictionFor("DE").posture).toBe("consent_required");
    expect(jurisdictionFor("AT").posture).toBe("consent_required");
  });

  it("treats the US as an opt-out regime", () => {
    expect(jurisdictionFor("US").posture).toBe("opt_out_regime");
  });

  it("is case and whitespace insensitive", () => {
    expect(jurisdictionFor(" ro ").country).toBe("RO");
    expect(jurisdictionFor("gb").country).toBe("GB");
  });

  it("defaults an unmapped country to the strict posture", () => {
    // Over-warning costs a dismissed banner; under-warning costs a fine.
    expect(jurisdictionFor("ZZ").posture).toBe("consent_required");
    expect(jurisdictionFor(undefined).posture).toBe("consent_required");
    expect(jurisdictionFor(null).posture).toBe("consent_required");
  });
});

describe("evaluateCompliance — suppression", () => {
  it("hard-blocks a suppressed address", () => {
    // The only hard block in the system: honouring an opt-out is not a
    // judgement call in any jurisdiction here.
    const verdict = evaluateCompliance(input({ suppressed: true }));
    expect(verdict.canSend).toBe(false);
    expect(verdict.issues[0]).toMatchObject({
      code: "suppressed",
      severity: "blocking",
    });
  });

  it("blocks suppression even in a permissive market", () => {
    const verdict = evaluateCompliance(
      input({ recipientCountry: "US", suppressed: true }),
    );
    expect(verdict.canSend).toBe(false);
  });

  it("does not ask for acknowledgement on an already-blocked recipient", () => {
    const verdict = evaluateCompliance(input({ suppressed: true }));
    expect(verdict.requiresAcknowledgement).toBe(false);
  });
});

describe("evaluateCompliance — strict markets", () => {
  it("warns but still permits sending to Romania", () => {
    // The explicit product decision: warn clearly, keep the send decision
    // with the user. Only suppression blocks.
    const verdict = evaluateCompliance(input());
    expect(verdict.canSend).toBe(true);
    expect(verdict.requiresAcknowledgement).toBe(true);
    expect(verdict.issues.map((i) => i.code)).toContain("consent_required");
  });

  it("stops asking once acknowledged", () => {
    const verdict = evaluateCompliance(input({ complianceAcknowledged: true }));
    expect(verdict.requiresAcknowledgement).toBe(false);
    expect(verdict.issues.map((i) => i.code)).not.toContain(
      "unacknowledged_strict_market",
    );
  });

  it("treats recorded consent as satisfying the rule", () => {
    const verdict = evaluateCompliance(input({ hasConsent: true }));
    expect(verdict.requiresAcknowledgement).toBe(false);
    expect(verdict.issues).toEqual([]);
  });

  it("flags auto-send as raising exposure in a strict market", () => {
    const verdict = evaluateCompliance(
      input({ autoSend: true, complianceAcknowledged: true }),
    );
    expect(verdict.issues.map((i) => i.code)).toContain(
      "auto_send_in_strict_market",
    );
  });

  it("suggests a role address over a personal mailbox in Romania", () => {
    const personal = evaluateCompliance(input({ complianceAcknowledged: true }));
    expect(personal.issues.map((i) => i.code)).toContain(
      "personal_address_in_strict_market",
    );

    const role = evaluateCompliance(
      input({ isRoleAddress: true, complianceAcknowledged: true }),
    );
    expect(role.issues.map((i) => i.code)).not.toContain(
      "personal_address_in_strict_market",
    );
  });

  it("does not suggest role addresses where they carry no advantage", () => {
    // In the UK the consent rule doesn't attach to the mailbox type.
    const verdict = evaluateCompliance(
      input({ recipientCountry: "GB", isRoleAddress: false }),
    );
    expect(verdict.issues.map((i) => i.code)).not.toContain(
      "personal_address_in_strict_market",
    );
  });
});

describe("evaluateCompliance — permissive markets", () => {
  it("raises no warnings for UK B2B outreach", () => {
    const verdict = evaluateCompliance(input({ recipientCountry: "GB" }));
    expect(verdict.canSend).toBe(true);
    expect(verdict.requiresAcknowledgement).toBe(false);
    expect(verdict.issues).toEqual([]);
  });

  it("raises no warnings for the US", () => {
    const verdict = evaluateCompliance(
      input({ recipientCountry: "US", autoSend: true }),
    );
    expect(verdict.issues).toEqual([]);
  });
});

describe("evaluateCompliance — required disclosures", () => {
  it("always requires an unsubscribe route and sender identity", () => {
    for (const country of ["RO", "GB", "US", "DE"]) {
      const verdict = evaluateCompliance(input({ recipientCountry: country }));
      expect(verdict.requiredDisclosures).toContain("unsubscribe_link");
      expect(verdict.requiredDisclosures).toContain("sender_identity");
    }
  });

  it("requires an Article 14 source notice in Europe but not the US", () => {
    // The recipient didn't hand over their details, so they must be told
    // where they came from.
    expect(
      evaluateCompliance(input({ recipientCountry: "RO" })).requiredDisclosures,
    ).toContain("data_source_notice");
    expect(
      evaluateCompliance(input({ recipientCountry: "GB" })).requiredDisclosures,
    ).toContain("data_source_notice");
    expect(
      evaluateCompliance(input({ recipientCountry: "US" })).requiredDisclosures,
    ).not.toContain("data_source_notice");
  });

  it("requires a postal address only for CAN-SPAM", () => {
    expect(
      evaluateCompliance(input({ recipientCountry: "US" })).requiredDisclosures,
    ).toContain("postal_address");
    expect(
      evaluateCompliance(input({ recipientCountry: "RO" })).requiredDisclosures,
    ).not.toContain("postal_address");
  });
});

describe("evaluateCampaign", () => {
  it("asks for acknowledgement when any recipient is in a strict market", () => {
    const result = evaluateCampaign([
      input({ recipientCountry: "GB" }),
      input({ recipientCountry: "US" }),
      input({ recipientCountry: "RO" }),
    ]);

    expect(result.requiresAcknowledgement).toBe(true);
    expect(result.strictCountries).toEqual(["Romania"]);
  });

  it("names every strict country, sorted", () => {
    const result = evaluateCampaign([
      input({ recipientCountry: "DE" }),
      input({ recipientCountry: "RO" }),
      input({ recipientCountry: "AT" }),
    ]);
    expect(result.strictCountries).toEqual(["Austria", "Germany", "Romania"]);
  });

  it("counts blocked recipients separately from warnings", () => {
    const result = evaluateCampaign([
      input({ recipientCountry: "US", suppressed: true }),
      input({ recipientCountry: "US" }),
    ]);

    expect(result.blockedCount).toBe(1);
    expect(result.requiresAcknowledgement).toBe(false);
  });

  it("stays quiet for an all-permissive campaign", () => {
    const result = evaluateCampaign([
      input({ recipientCountry: "GB" }),
      input({ recipientCountry: "NL" }),
    ]);

    expect(result.requiresAcknowledgement).toBe(false);
    expect(result.strictCountries).toEqual([]);
    expect(result.blockedCount).toBe(0);
  });

  it("handles an empty campaign", () => {
    const result = evaluateCampaign([]);
    expect(result.requiresAcknowledgement).toBe(false);
    expect(result.verdicts).toEqual([]);
  });
});
