import type { Icp } from "@/lib/icp/schema";
import { scoreTitleMatch } from "@/lib/sources/people/seniority";
import type { SourcedCompany } from "@/lib/sources/types";
import {
  NEGATIVE_SIGNALS,
  recencyMultiplier,
  type Signal,
} from "./types";

/**
 * Lead scoring.
 *
 * Produces a 0-100 score and, just as importantly, a breakdown explaining it.
 * Every component records what it contributed and why, so the UI can answer
 * "why is this lead at the top" with specifics rather than a number. A score a
 * user can't interrogate is a score they won't trust.
 *
 * Four components, deliberately weighted:
 *   ICP fit          — does this company and person match who you sell to
 *   Signal strength  — is there a reason to reach out *now*
 *   Contactability   — can we actually reach them
 *   Penalties        — reasons to leave them alone
 *
 * Fit is weighted highest because a perfectly-timed signal at a bad-fit company
 * is still a wasted email, while a good-fit company with no signal is merely
 * early.
 */

const WEIGHTS = {
  icpFit: 0.45,
  signals: 0.35,
  contactability: 0.2,
} as const;

export type ScoreReason = {
  label: string;
  /** Contribution to this component, 0-1. Negative for penalties. */
  points: number;
};

export type ScoreBreakdown = {
  /** Final 0-100 score. */
  total: number;
  icpFit: { score: number; weight: number; reasons: ScoreReason[] };
  signals: { score: number; weight: number; reasons: ScoreReason[] };
  contactability: { score: number; weight: number; reasons: ScoreReason[] };
  penalties: { total: number; reasons: ScoreReason[] };
  /** Set when a hard rule disqualifies the lead outright. */
  disqualified?: string;
};

export type ScoreInput = {
  icp: Icp;
  company: SourcedCompany;
  person?: { fullName: string; title?: string };
  signals?: Signal[];
  email?: {
    status: "pattern" | "found" | "verified" | "risky" | "invalid" | "bounced";
    confidence: number;
    isRoleAddress: boolean;
  };
  /** Addresses and domains the org has suppressed. */
  suppressed?: boolean;
  now?: Date;
};

export function scoreLead(input: ScoreInput): ScoreBreakdown {
  const now = input.now ?? new Date();

  const icpFit = scoreIcpFit(input);
  const signals = scoreSignals(input.signals ?? [], now);
  const contactability = scoreContactability(input);
  const penalties = scorePenalties(input);

  const weighted =
    icpFit.score * WEIGHTS.icpFit +
    signals.score * WEIGHTS.signals +
    contactability.score * WEIGHTS.contactability;

  const total = Math.round(
    Math.max(0, Math.min(1, weighted + penalties.total)) * 100,
  );

  const disqualified = findDisqualifier(input);

  return {
    // A disqualified lead scores zero regardless of how well it otherwise
    // reads — an insolvent company is not a lead at any fit level.
    total: disqualified ? 0 : total,
    icpFit: { ...icpFit, weight: WEIGHTS.icpFit },
    signals: { ...signals, weight: WEIGHTS.signals },
    contactability: { ...contactability, weight: WEIGHTS.contactability },
    penalties,
    disqualified,
  };
}

/** Hard rules. These override the score rather than nudging it. */
function findDisqualifier(input: ScoreInput): string | undefined {
  if (input.suppressed) return "On your do-not-contact list";
  if (input.company.insolvencyStatus) {
    return input.company.insolvencyStatus === "anaf_inactive"
      ? "Listed as an inactive taxpayer at ANAF"
      : "Insolvency proceedings on record";
  }
  if (input.email?.status === "bounced") return "Previous email bounced";
  if (input.email?.status === "invalid") return "Email address is invalid";

  const exclusion = matchedExclusion(input);
  if (exclusion) return `Matches your exclusion "${exclusion}"`;

  return undefined;
}

function matchedExclusion(input: ScoreInput): string | undefined {
  const haystack = [
    input.company.name,
    input.company.industry,
    input.company.description,
    input.company.domain,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return input.icp.exclusions.find((exclusion) => {
    const needle = exclusion.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

function scoreIcpFit(input: ScoreInput): { score: number; reasons: ScoreReason[] } {
  const { icp, company, person } = input;
  const reasons: ScoreReason[] = [];

  // --- Person fit (half the component when a person is known) -------------
  let personScore = 0;
  if (person) {
    personScore = scoreTitleMatch(person.title, icp);
    if (personScore >= 1) {
      reasons.push({ label: `${person.title} is a target title`, points: 1 });
    } else if (personScore >= 0.85) {
      reasons.push({ label: `${person.title} closely matches a target title`, points: personScore });
    } else if (personScore >= 0.6) {
      reasons.push({ label: `${person.title} is a target seniority`, points: personScore });
    } else if (person.title) {
      reasons.push({ label: `${person.title} is outside your target roles`, points: 0 });
    }
  }

  // --- Company fit --------------------------------------------------------
  const companyChecks: ScoreReason[] = [];

  if (icp.caenCodes.length > 0 && company.caen) {
    if (icp.caenCodes.includes(company.caen)) {
      companyChecks.push({
        label: `CAEN ${company.caen} is a target activity code`,
        points: 1,
      });
    } else if (icp.caenCodes.some((c) => c.slice(0, 2) === company.caen?.slice(0, 2))) {
      // Same division is a real but weaker match — a neighbouring activity
      // code often means an adjacent business, not the same one.
      companyChecks.push({
        label: `CAEN ${company.caen} is in a target division`,
        points: 0.6,
      });
    } else {
      companyChecks.push({ label: `CAEN ${company.caen} is off-target`, points: 0 });
    }
  }

  if (icp.countries.length > 0 && company.country) {
    const match = icp.countries.includes(company.country);
    companyChecks.push({
      label: match
        ? `Based in ${company.country}, a target market`
        : `Based in ${company.country}, outside your markets`,
      points: match ? 1 : 0,
    });
  }

  const headcount = company.employeesAnaf ?? company.employeeCount;
  if (headcount !== undefined && (icp.employeeMin !== null || icp.employeeMax !== null)) {
    const aboveMin = icp.employeeMin === null || headcount >= icp.employeeMin;
    const belowMax = icp.employeeMax === null || headcount <= icp.employeeMax;
    companyChecks.push({
      label:
        aboveMin && belowMax
          ? `${headcount} employees is in range`
          : `${headcount} employees is outside your range`,
      points: aboveMin && belowMax ? 1 : 0,
    });
  }

  if (company.revenueRon !== undefined && (icp.revenueMinRon !== null || icp.revenueMaxRon !== null)) {
    const aboveMin = icp.revenueMinRon === null || company.revenueRon >= icp.revenueMinRon;
    const belowMax = icp.revenueMaxRon === null || company.revenueRon <= icp.revenueMaxRon;
    companyChecks.push({
      label:
        aboveMin && belowMax
          ? `Revenue ${formatRon(company.revenueRon)} is in range`
          : `Revenue ${formatRon(company.revenueRon)} is outside your range`,
      points: aboveMin && belowMax ? 1 : 0,
    });
  }

  const companyScore =
    companyChecks.length > 0
      ? companyChecks.reduce((sum, c) => sum + c.points, 0) / companyChecks.length
      : // No criteria to check against isn't a bad fit, it's an unknown one.
        // Scoring it 0 would bury every lead for a loosely-defined ICP.
        0.5;

  reasons.push(...companyChecks);

  const score = person ? personScore * 0.5 + companyScore * 0.5 : companyScore;
  return { score: clamp(score), reasons };
}

function scoreSignals(
  signals: Signal[],
  now: Date,
): { score: number; reasons: ScoreReason[] } {
  if (signals.length === 0) {
    return {
      score: 0,
      reasons: [{ label: "No buying signals detected yet", points: 0 }],
    };
  }

  const reasons: ScoreReason[] = [];
  let positive = 0;

  for (const signal of signals) {
    const decay = recencyMultiplier(signal.type, signal.detectedAt, now);
    const effective = signal.strength * decay;

    reasons.push({
      label: `${signal.title} (${describeAge(signal.detectedAt, now)})`,
      points: NEGATIVE_SIGNALS.has(signal.type) ? -effective : effective,
    });

    // Negative signals are handled as penalties, not by subtracting here —
    // otherwise one stale distress signal could cancel a strong fresh one.
    if (!NEGATIVE_SIGNALS.has(signal.type)) positive += effective;
  }

  // Diminishing returns: three good signals is meaningfully better than one,
  // ten is not meaningfully better than three. Without this, a company with
  // many weak signals outranks one with a single decisive signal.
  const score = 1 - Math.exp(-positive / 1.5);

  return { score: clamp(score), reasons: reasons.sort((a, b) => b.points - a.points) };
}

function scoreContactability(
  input: ScoreInput,
): { score: number; reasons: ScoreReason[] } {
  const email = input.email;

  if (!email) {
    return {
      score: 0,
      reasons: [{ label: "No email address found", points: 0 }],
    };
  }

  // Deliberately steep between verified and guessed: the difference decides
  // whether outreach can be automated or needs a human first.
  const base: Record<string, { score: number; label: string }> = {
    verified: { score: 1, label: "Verified email address" },
    found: { score: 0.75, label: "Email found at source" },
    pattern: { score: 0.4, label: "Email inferred from the company's pattern" },
    risky: { score: 0.25, label: "Email flagged as risky" },
    invalid: { score: 0, label: "Email address is invalid" },
    bounced: { score: 0, label: "Previous email bounced" },
  };

  const entry = base[email.status] ?? { score: 0.2, label: "Email status unknown" };
  const reasons: ScoreReason[] = [{ label: entry.label, points: entry.score }];

  let score = entry.score * (0.6 + 0.4 * clamp(email.confidence));

  if (email.isRoleAddress) {
    // Reaches the company, not the person — worth less for personalised
    // outreach, though it is the RO-defensible route.
    score *= 0.7;
    reasons.push({ label: "Role address, not a personal one", points: -0.3 });
  }

  return { score: clamp(score), reasons };
}

function scorePenalties(input: ScoreInput): { total: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let total = 0;

  for (const signal of input.signals ?? []) {
    if (!NEGATIVE_SIGNALS.has(signal.type)) continue;
    const decay = recencyMultiplier(signal.type, signal.detectedAt, input.now ?? new Date());
    const penalty = -0.25 * signal.strength * decay;
    total += penalty;
    reasons.push({ label: signal.title, points: penalty });
  }

  if (input.company.vatRegistered === false) {
    // Not VAT-registered in Romania usually means very small or dormant —
    // a weak negative, not a disqualifier, since young companies qualify too.
    total -= 0.05;
    reasons.push({ label: "Not registered for VAT", points: -0.05 });
  }

  return { total: Math.max(-0.5, total), reasons };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function describeAge(detectedAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - detectedAt.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}

function formatRon(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M RON`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k RON`;
  return `${value} RON`;
}

/** One-line explanation for a lead list row. */
export function summariseScore(breakdown: ScoreBreakdown): string {
  if (breakdown.disqualified) return breakdown.disqualified;

  const topSignal = breakdown.signals.reasons.find((r) => r.points > 0);
  if (topSignal) return topSignal.label;

  const topFit = breakdown.icpFit.reasons.find((r) => r.points > 0);
  return topFit ? topFit.label : "Matches your profile, no signals yet";
}
