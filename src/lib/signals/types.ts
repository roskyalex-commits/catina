import type { SourcedCompany } from "@/lib/sources/types";

/**
 * Buying-intent signals.
 *
 * Every signal must carry an `evidenceUrl` pointing at the public source it
 * came from. That is the stated differentiator over Gojiberry: a user can
 * click through and see the job posting, the filing, or the news item for
 * themselves rather than trusting a score. A source that cannot produce a link
 * should not emit a signal.
 */

export type SignalType =
  | "hiring_surge"
  | "hiring_buyer_role"
  | "funding_news"
  | "expansion_news"
  | "anaf_revenue_growth"
  | "anaf_revenue_decline"
  | "vat_registered"
  | "insolvency_risk"
  | "newly_registered"
  | "tech_stack_added"
  | "tech_stack_removed"
  | "pricing_page_changed"
  | "contact_job_change";

export type Signal = {
  type: SignalType;
  /** One line, shown verbatim in the UI. Written for the seller, not the log. */
  title: string;
  /** Public URL backing the claim. Required in spirit — see the note above. */
  evidenceUrl?: string;
  /** 0-1, before recency decay. How strong this signal is at its freshest. */
  strength: number;
  detectedAt: Date;
  /**
   * Natural key for the source, so a rescan updates rather than duplicates.
   * Must be stable across runs for the same underlying event.
   */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  /** Set when the signal concerns a specific person, not the whole company. */
  personLinkedinUrl?: string;
};

export type SignalScanContext = {
  company: SourcedCompany;
  /** Previous scan's state, for sources that work by diffing. */
  previous?: {
    techStack?: string[];
    pricingPageHash?: string;
    careersJobTitles?: string[];
    revenueRon?: number;
    vatRegistered?: boolean;
  };
  /** Titles the ICP is after, so hiring sources can spot a buyer-shaped role. */
  targetTitles?: string[];
};

export interface SignalSource {
  readonly key: string;
  readonly label: string;
  /** Shown in onboarding step 4, where the user picks signals. */
  readonly description: string;
  /** False when this source can't apply — e.g. a non-Romanian company. */
  isApplicable(context: SignalScanContext): boolean;
  scan(context: SignalScanContext): Promise<Signal[]>;
}

/**
 * Half-life in days, per signal type.
 *
 * Signals decay at very different rates and treating them uniformly is the
 * main way a scoring engine goes wrong. A job posting is stale in a month; an
 * annual filing is the best information available for a year, and decaying it
 * quickly would throw away the one signal no competitor has.
 */
export const SIGNAL_HALF_LIFE_DAYS: Record<SignalType, number> = {
  hiring_surge: 30,
  hiring_buyer_role: 30,
  funding_news: 60,
  expansion_news: 45,
  // Filed once a year — it stays the freshest fact available for months.
  anaf_revenue_growth: 240,
  anaf_revenue_decline: 240,
  vat_registered: 120,
  // Distress is not a buying signal; it disqualifies, and slowly.
  insolvency_risk: 365,
  newly_registered: 90,
  tech_stack_added: 60,
  tech_stack_removed: 60,
  pricing_page_changed: 30,
  contact_job_change: 90,
};

/**
 * Signals that count against a lead rather than for it.
 *
 * Kept as data rather than a sign on `strength` so a source never has to
 * remember to negate, and so the UI can style them distinctly.
 */
export const NEGATIVE_SIGNALS: ReadonlySet<SignalType> = new Set([
  "insolvency_risk",
  "anaf_revenue_decline",
]);

/**
 * Exponential decay by half-life. Returns the multiplier to apply to a
 * signal's strength given how long ago it was detected.
 */
export function recencyMultiplier(
  type: SignalType,
  detectedAt: Date,
  now = new Date(),
): number {
  const ageDays = (now.getTime() - detectedAt.getTime()) / 86_400_000;
  // A clock skew or a future-dated source shouldn't inflate a score.
  if (ageDays <= 0) return 1;
  return 0.5 ** (ageDays / SIGNAL_HALF_LIFE_DAYS[type]);
}
