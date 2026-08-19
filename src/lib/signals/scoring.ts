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
  const contactability = scoreContactability(input.email);
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

/**
 * Re-score a lead after enrichment resolved (or failed to resolve) an address.
 *
 * Enrichment changes exactly one of the four components. Re-running `scoreLead`
 * would mean re-fetching the agent's ICP, the company and its signals purely to
 * recompute values that have not moved — and any drift between the two reads
 * would show up as a score that changed for reasons nobody asked about. So the
 * other three components are carried over from the stored breakdown verbatim
 * and only contactability is recomputed, with the same weights and the same
 * rounding as `scoreLead`.
 *
 * The one subtlety is disqualification. A previous enrichment may have
 * disqualified this lead for a bad address; if the new one is good, that verdict
 * must be dropped rather than inherited. Non-email disqualifiers (insolvency,
 * suppression, exclusions) are untouched by enrichment and survive.
 */
export function rescoreWithEmail(
  breakdown: ScoreBreakdown,
  email: ScoreInput["email"],
): ScoreBreakdown {
  const contactability = scoreContactability(email);

  const weighted =
    breakdown.icpFit.score * WEIGHTS.icpFit +
    breakdown.signals.score * WEIGHTS.signals +
    contactability.score * WEIGHTS.contactability;

  const total = Math.round(
    Math.max(0, Math.min(1, weighted + breakdown.penalties.total)) * 100,
  );

  const carried = EMAIL_DISQUALIFIERS.has(breakdown.disqualified ?? "")
    ? undefined
    : breakdown.disqualified;
  const disqualified = emailDisqualifier(email) ?? carried;

  return {
    ...breakdown,
    total: disqualified ? 0 : total,
    contactability: { ...contactability, weight: WEIGHTS.contactability },
    disqualified,
  };
}

/**
 * Reasons an address itself kills a lead.
 *
 * Listed once and compared by value, because `rescoreWithEmail` has to tell a
 * verdict it wrote on a previous pass from one that came from somewhere else.
 */
const EMAIL_DISQUALIFIERS = new Set<string>([
  "Previous email bounced",
  "Email address is invalid",
]);

function emailDisqualifier(email: ScoreInput["email"]): string | undefined {
  if (email?.status === "bounced") return "Previous email bounced";
  if (email?.status === "invalid") return "Email address is invalid";
  return undefined;
}

/**
 * Re-score a lead after a scan produced new signals.
 *
 * Same shape as `rescoreWithEmail`, and for the same reason: a scan learns
 * nothing about ICP fit or contactability, so re-deriving them would mean
 * re-reading the agent, the company and its emails purely to recompute values
 * that have not moved — and any drift between the two reads would surface as a
 * score that changed for reasons nobody asked about.
 *
 * Signals touch **two** components rather than one. Negative signals are
 * deliberately routed to penalties rather than subtracted from the signal score
 * (see `scoreSignals`), so both halves are recomputed here. The VAT penalty
 * comes from the company row, not from a signal, so it is carried across by
 * label — the same compare-by-value trick `EMAIL_DISQUALIFIERS` uses.
 */
export function rescoreWithSignals(
  breakdown: ScoreBreakdown,
  signals: Signal[],
  now = new Date(),
): ScoreBreakdown {
  const scored = scoreSignals(signals, now);
  const fromSignals = signalPenalties(signals, now);

  // Everything in the stored penalties that a signal did not put there.
  const carriedPenalties = breakdown.penalties.reasons.filter(
    (reason) => reason.label === VAT_PENALTY_LABEL,
  );
  const carriedTotal = carriedPenalties.reduce((sum, r) => sum + r.points, 0);

  const penalties = {
    total: Math.max(-0.5, fromSignals.total + carriedTotal),
    reasons: [...fromSignals.reasons, ...carriedPenalties],
  };

  const weighted =
    breakdown.icpFit.score * WEIGHTS.icpFit +
    scored.score * WEIGHTS.signals +
    breakdown.contactability.score * WEIGHTS.contactability;

  const total = Math.round(
    Math.max(0, Math.min(1, weighted + penalties.total)) * 100,
  );

  /*
   * Distress is re-decided from the signals present, not inherited.
   *
   * A company can come off the inactive list, and a verdict recorded on a
   * previous scan would otherwise keep the lead dead forever. Non-signal
   * disqualifiers — suppression, exclusions, a bad email — are untouched by a
   * scan and survive.
   */
  const insolvent = signals.some((signal) => signal.type === "insolvency_risk");
  const carriedVerdict = SIGNAL_DISQUALIFIERS.has(breakdown.disqualified ?? "")
    ? undefined
    : breakdown.disqualified;
  const disqualified = insolvent
    ? "Insolvency proceedings on record"
    : carriedVerdict;

  return {
    ...breakdown,
    total: disqualified ? 0 : total,
    signals: { ...scored, weight: WEIGHTS.signals },
    penalties,
    disqualified,
  };
}

/**
 * Verdicts a scan is entitled to withdraw.
 *
 * Only the ones a signal can produce. Compared by value for the same reason as
 * `EMAIL_DISQUALIFIERS`: a rescore has to tell a verdict it wrote itself from
 * one that came from somewhere it knows nothing about.
 */
const SIGNAL_DISQUALIFIERS: ReadonlySet<string> = new Set([
  "Insolvency proceedings on record",
  "Listed as an inactive taxpayer at ANAF",
]);

/** Hard rules. These override the score rather than nudging it. */
function findDisqualifier(input: ScoreInput): string | undefined {
  if (input.suppressed) return "On your do-not-contact list";
  if (input.company.insolvencyStatus) {
    return input.company.insolvencyStatus === "anaf_inactive"
      ? "Listed as an inactive taxpayer at ANAF"
      : "Insolvency proceedings on record";
  }
  const emailProblem = emailDisqualifier(input.email);
  if (emailProblem) return emailProblem;

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
  email: ScoreInput["email"],
): { score: number; reasons: ScoreReason[] } {
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

/**
 * Penalties that come from signals.
 *
 * Split from the company-derived ones so `rescoreWithSignals` can recompute
 * exactly this half and carry the other verbatim. Two implementations of the
 * same arithmetic would drift, and the drift would show up as a lead whose
 * score changed for no reason anyone could name.
 */
export function signalPenalties(
  signals: Signal[],
  now: Date,
): { total: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let total = 0;

  for (const signal of signals) {
    if (!NEGATIVE_SIGNALS.has(signal.type)) continue;
    const decay = recencyMultiplier(signal.type, signal.detectedAt, now);
    const penalty = -0.25 * signal.strength * decay;
    total += penalty;
    reasons.push({ label: signal.title, points: penalty });
  }

  return { total, reasons };
}

/** The label the VAT penalty is recorded under, so a rescore can recognise it. */
const VAT_PENALTY_LABEL = "Not registered for VAT";

/** Penalties that come from the company row, and so survive a signal rescore. */
function companyPenalties(
  company: ScoreInput["company"],
): { total: number; reasons: ScoreReason[] } {
  if (company.vatRegistered === false) {
    // Not VAT-registered in Romania usually means very small or dormant —
    // a weak negative, not a disqualifier, since young companies qualify too.
    return { total: -0.05, reasons: [{ label: VAT_PENALTY_LABEL, points: -0.05 }] };
  }
  return { total: 0, reasons: [] };
}

function scorePenalties(input: ScoreInput): { total: number; reasons: ScoreReason[] } {
  const fromSignals = signalPenalties(input.signals ?? [], input.now ?? new Date());
  const fromCompany = companyPenalties(input.company);

  return {
    total: Math.max(-0.5, fromSignals.total + fromCompany.total),
    reasons: [...fromSignals.reasons, ...fromCompany.reasons],
  };
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
