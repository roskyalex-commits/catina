/**
 * Jurisdiction rules for cold B2B email.
 *
 * The premise most outreach tools get wrong: "GDPR compliance" is not one
 * thing. GDPR governs whether you may *process* someone's data; whether you
 * may *send* them an unsolicited commercial email is set by each country's
 * ePrivacy implementation, and those differ sharply. Romania and Germany
 * require prior consent with no B2B carve-out; the UK and the Netherlands
 * allow B2B outreach on legitimate interest with an opt-out.
 *
 * A tool that treats every EU country the same either over-blocks the
 * permissive markets or quietly exposes the user in the strict ones. This
 * table is the alternative, and knowing Romanian law specifically is the
 * product's differentiator in its home market.
 *
 * This is not legal advice, and the rules are summaries. It is here so the
 * product can warn accurately rather than generically.
 */

export type Posture =
  | "consent_required"
  | "legitimate_interest"
  | "opt_out_regime";

export type JurisdictionRule = {
  country: string;
  countryName: string;
  posture: Posture;
  /** Short line shown on the lead row. */
  summary: string;
  /** Longer explanation for the campaign warning. */
  detail: string;
  /** Statute the rule comes from, so a user can look it up. */
  statute: string;
  /**
   * True when role addresses (office@, contact@) are materially safer than
   * personal ones — generally where the consent rule attaches to a natural
   * person rather than to the mailbox.
   */
  roleAddressSafer: boolean;
};

const RULES: Record<string, JurisdictionRule> = {
  RO: {
    country: "RO",
    countryName: "Romania",
    posture: "consent_required",
    summary: "Requires prior opt-in — no B2B exemption",
    detail:
      "Romania has no B2B exemption for unsolicited commercial email. Law 506/2004 " +
      "requires express prior consent, and ANSPDCP can fine RON 5,000–100,000, or up " +
      "to 2% of turnover for companies above RON 5M. Role addresses published by the " +
      "company for contact purposes carry materially less risk than personal mailboxes.",
    statute: "Law 506/2004, art. 12",
    roleAddressSafer: true,
  },
  DE: {
    country: "DE",
    countryName: "Germany",
    posture: "consent_required",
    summary: "Requires prior opt-in — strictly enforced",
    detail:
      "Germany requires prior consent for commercial email including B2B, under UWG §7. " +
      "Enforcement is largely by competitor warning letters (Abmahnung), which makes it " +
      "one of the highest-risk markets for cold email.",
    statute: "UWG §7",
    roleAddressSafer: true,
  },
  AT: {
    country: "AT",
    countryName: "Austria",
    posture: "consent_required",
    summary: "Requires prior opt-in",
    detail:
      "Austria requires prior consent for unsolicited commercial email, with no general " +
      "B2B exemption, under TKG §174 (formerly §107).",
    statute: "TKG §174",
    roleAddressSafer: true,
  },
  IT: {
    country: "IT",
    countryName: "Italy",
    posture: "consent_required",
    summary: "Requires prior opt-in",
    detail:
      "Italy requires prior consent for commercial email under the Privacy Code, and the " +
      "Garante has applied it to B2B outreach.",
    statute: "D.Lgs. 196/2003",
    roleAddressSafer: true,
  },
  CA: {
    country: "CA",
    countryName: "Canada",
    posture: "consent_required",
    summary: "CASL — consent required, with a published-address exception",
    detail:
      "CASL requires express or implied consent. Implied consent covers a business address " +
      "published publicly without a statement refusing unsolicited mail, where the message " +
      "relates to the recipient's role — narrower than it sounds.",
    statute: "CASL (S.C. 2010, c. 23)",
    roleAddressSafer: true,
  },

  // --- Legitimate-interest markets ---------------------------------------
  GB: {
    country: "GB",
    countryName: "United Kingdom",
    posture: "legitimate_interest",
    summary: "B2B allowed with opt-out",
    detail:
      "PECR exempts corporate subscribers from the consent rule, so B2B cold email to a " +
      "company is permitted on legitimate interest, provided the sender is identified and " +
      "an opt-out is offered. Sole traders and partnerships count as individuals.",
    statute: "PECR reg. 22",
    roleAddressSafer: false,
  },
  NL: {
    country: "NL",
    countryName: "Netherlands",
    posture: "legitimate_interest",
    summary: "B2B allowed with opt-out",
    detail:
      "The Dutch Telecommunications Act permits B2B email to corporate addresses with a " +
      "clear opt-out and sender identification.",
    statute: "Telecommunicatiewet art. 11.7",
    roleAddressSafer: false,
  },
  FR: {
    country: "FR",
    countryName: "France",
    posture: "legitimate_interest",
    summary: "B2B allowed if relevant to the recipient's role",
    detail:
      "CNIL permits B2B email without prior consent where the message relates to the " +
      "recipient's professional function, with identification and an opt-out.",
    statute: "CNIL B2B guidance",
    roleAddressSafer: false,
  },
  SE: legitimateInterest("SE", "Sweden"),
  DK: legitimateInterest("DK", "Denmark"),
  NO: legitimateInterest("NO", "Norway"),
  FI: legitimateInterest("FI", "Finland"),
  IE: legitimateInterest("IE", "Ireland"),
  BE: legitimateInterest("BE", "Belgium"),
  PL: legitimateInterest("PL", "Poland"),
  ES: legitimateInterest("ES", "Spain"),
  PT: legitimateInterest("PT", "Portugal"),
  CZ: legitimateInterest("CZ", "Czechia"),

  US: {
    country: "US",
    countryName: "United States",
    posture: "opt_out_regime",
    summary: "CAN-SPAM — opt-out, no prior consent needed",
    detail:
      "CAN-SPAM permits unsolicited commercial email provided headers are accurate, the " +
      "message is identifiable as an ad where required, a working opt-out is offered and " +
      "honoured within 10 business days, and a valid physical postal address is included.",
    statute: "15 U.S.C. §7701 (CAN-SPAM)",
    roleAddressSafer: false,
  },
};

function legitimateInterest(country: string, countryName: string): JurisdictionRule {
  return {
    country,
    countryName,
    posture: "legitimate_interest",
    summary: "B2B allowed with opt-out",
    detail:
      `${countryName} generally permits B2B email to corporate addresses under a ` +
      "legitimate-interest basis, with sender identification and a working opt-out. " +
      "Confirm the national implementation before a large campaign.",
    statute: "National ePrivacy implementation",
    roleAddressSafer: false,
  };
}

/**
 * Unknown countries default to the strict posture.
 *
 * Deliberate: the cost of over-warning is a dismissed banner, and the cost of
 * under-warning is a fine. Defaulting an unmapped jurisdiction to "permitted"
 * would make the least-researched markets the most dangerous.
 */
export const UNKNOWN_JURISDICTION: JurisdictionRule = {
  country: "??",
  countryName: "Unknown jurisdiction",
  posture: "consent_required",
  summary: "Rules unknown — treated as consent-required",
  detail:
    "We don't have a rule on file for this country, so it is treated as requiring prior " +
    "consent. Check the local ePrivacy implementation before sending.",
  statute: "—",
  roleAddressSafer: true,
};

export function jurisdictionFor(country: string | undefined | null): JurisdictionRule {
  if (!country) return UNKNOWN_JURISDICTION;
  return RULES[country.trim().toUpperCase()] ?? UNKNOWN_JURISDICTION;
}

/* ------------------------------------------------------------------ checks */

export type ComplianceInput = {
  recipientCountry?: string | null;
  recipientEmail: string;
  isRoleAddress: boolean;
  /** True when the org has recorded consent or a prior relationship. */
  hasConsent?: boolean;
  suppressed?: boolean;
  /** Whether the campaign is set to send without human review. */
  autoSend: boolean;
  /** Whether the user has acknowledged the strict-market warning. */
  complianceAcknowledged?: boolean;
};

export type ComplianceIssue = {
  code:
    | "suppressed"
    | "consent_required"
    | "unacknowledged_strict_market"
    | "auto_send_in_strict_market"
    | "personal_address_in_strict_market"
    | "unknown_jurisdiction";
  severity: "blocking" | "warning" | "info";
  message: string;
};

export type ComplianceVerdict = {
  jurisdiction: JurisdictionRule;
  /** False only for a hard block — currently just the suppression list. */
  canSend: boolean;
  /** True when the UI must interrupt before this campaign can queue. */
  requiresAcknowledgement: boolean;
  issues: ComplianceIssue[];
  /** Disclosures that must appear in the message body. */
  requiredDisclosures: RequiredDisclosure[];
};

export type RequiredDisclosure =
  | "unsubscribe_link"
  | "sender_identity"
  | "postal_address"
  | "data_source_notice";

/**
 * Evaluates one recipient.
 *
 * Note what this deliberately does *not* do: block sending in strict markets.
 * That was an explicit product decision — the tool warns clearly and records
 * an acknowledgement, and the send decision stays with the user. The one hard
 * block is the suppression list, because honouring an opt-out is not a
 * judgement call.
 */
export function evaluateCompliance(input: ComplianceInput): ComplianceVerdict {
  const jurisdiction = jurisdictionFor(input.recipientCountry);
  const issues: ComplianceIssue[] = [];

  if (input.suppressed) {
    issues.push({
      code: "suppressed",
      severity: "blocking",
      message:
        "This address is on your do-not-contact list. Honouring an opt-out is a legal " +
        "requirement in every jurisdiction here.",
    });
  }

  const strict = jurisdiction.posture === "consent_required";
  const consented = input.hasConsent === true;

  if (strict && !consented) {
    if (jurisdiction === UNKNOWN_JURISDICTION) {
      issues.push({
        code: "unknown_jurisdiction",
        severity: "warning",
        message: jurisdiction.detail,
      });
    } else {
      issues.push({
        code: "consent_required",
        severity: "warning",
        message: `${jurisdiction.countryName}: ${jurisdiction.detail}`,
      });
    }

    if (!input.complianceAcknowledged) {
      issues.push({
        code: "unacknowledged_strict_market",
        severity: "warning",
        message:
          `This campaign includes recipients in ${jurisdiction.countryName}, where prior ` +
          "consent is required. Confirm you want to proceed.",
      });
    }

    if (input.autoSend) {
      issues.push({
        code: "auto_send_in_strict_market",
        severity: "warning",
        message:
          "Auto-send is on for a market that requires prior consent. Reviewing each " +
          "message before it goes out materially reduces your exposure.",
      });
    }

    if (jurisdiction.roleAddressSafer && !input.isRoleAddress) {
      issues.push({
        code: "personal_address_in_strict_market",
        severity: "info",
        message:
          "This is a personal mailbox. A published role address (office@, contact@) is " +
          "the lower-risk route in this market.",
      });
    }
  }

  return {
    jurisdiction,
    canSend: !input.suppressed,
    requiresAcknowledgement:
      strict && !consented && !input.complianceAcknowledged && !input.suppressed,
    issues,
    requiredDisclosures: disclosuresFor(jurisdiction),
  };
}

function disclosuresFor(jurisdiction: JurisdictionRule): RequiredDisclosure[] {
  const disclosures: RequiredDisclosure[] = [
    "unsubscribe_link",
    "sender_identity",
  ];

  // GDPR Art. 14: when data was not collected from the person, they must be
  // told where it came from. Applies across the EEA and the UK regardless of
  // the ePrivacy posture.
  if (jurisdiction.posture !== "opt_out_regime") {
    disclosures.push("data_source_notice");
  }
  // CAN-SPAM requires a valid physical postal address in the message itself.
  if (jurisdiction.country === "US") {
    disclosures.push("postal_address");
  }
  return disclosures;
}

/** Aggregates a campaign's recipients into one decision for the UI. */
export function evaluateCampaign(
  recipients: ComplianceInput[],
): {
  requiresAcknowledgement: boolean;
  strictCountries: string[];
  blockedCount: number;
  verdicts: ComplianceVerdict[];
} {
  const verdicts = recipients.map(evaluateCompliance);
  const strict = new Set<string>();

  for (const verdict of verdicts) {
    if (verdict.jurisdiction.posture === "consent_required") {
      strict.add(verdict.jurisdiction.countryName);
    }
  }

  return {
    requiresAcknowledgement: verdicts.some((v) => v.requiresAcknowledgement),
    strictCountries: [...strict].sort(),
    blockedCount: verdicts.filter((v) => !v.canSend).length,
    verdicts,
  };
}
