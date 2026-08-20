import type { ScanPerson, Signal } from "../types";

/**
 * The slot a paid data provider plugs into.
 *
 * Two of Gojiberry's four signal categories — "people engaging with your
 * market" and "people aware of your brand" — have no free, legal source. They
 * are LinkedIn engagement, and there is no honest substitute for it. Rather
 * than fake them with a proxy, everything that would be needed to serve them is
 * built and empty: the context carries `people`, `signals.person_id` exists,
 * `upsertSignals` resolves a LinkedIn URL to a person, and this interface is
 * where the vendor call goes.
 *
 * The contract is deliberately the same shape as `PeopleProvider` in
 * `src/lib/sources/people/types.ts`, down to `probe()` being separate from the
 * real call. That separation earned its place during the email spike: several
 * vendors sell a plan whose API is gated behind a much higher tier, and finding
 * that out should not cost the credits the coverage test needs.
 *
 * ## What connecting one changes, and what it does not
 *
 * A provider returns `Signal`s in exactly the format every free source returns,
 * so scoring, decay, dedupe, persistence and the evidence link all work
 * unchanged the moment a key is added. Nothing downstream of `SignalScanner`
 * knows a signal was paid for.
 *
 * What it must not change is the rule that a signal carries a public URL a user
 * can open. A provider that returns "this person is interested in CRM" with no
 * link is returning a score, not a signal, and belongs behind a different
 * surface — see `evidenceUrl` on `Signal`.
 */

export type PersonSignalRequest = {
  company: { name: string; domain?: string; linkedinUrl?: string };
  /** People already known at this company. May be empty. */
  people: ScanPerson[];
  /** ICP keywords — the topics whose engagement we want. */
  topics: string[];
  /** Competitor brands whose followers and engagers are worth knowing. */
  competitors: string[];
  /** Ignore activity older than this. Providers charge by window. */
  since?: Date;
};

export type ProviderQuota = {
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
};

export type PersonProviderProbe = {
  provider: string;
  /** False when no key is set — not a failure, just unconfigured. */
  configured: boolean;
  /** True only when a live call succeeded. */
  apiAccessible: boolean;
  quota?: ProviderQuota;
  planName?: string;
  error?: string;
};

export interface PersonSignalProvider {
  readonly key: string;
  readonly label: string;
  /**
   * Credits one company's lookup costs, charged against `CreditLedger`.
   *
   * A number rather than a boolean because the scan has to decide how many
   * companies it can afford *before* it starts, and "expensive" is not a
   * quantity a scheduler can divide a budget by.
   */
  readonly costPerCompany: number;
  /** What the paid tier is documented to allow. Shown next to the toggle. */
  readonly pricingNote: string;

  isConfigured(): boolean;
  probe(): Promise<PersonProviderProbe>;
  fetchSignals(request: PersonSignalRequest): Promise<Signal[]>;
}

/**
 * Providers we would buy, with what each one would actually unlock.
 *
 * Kept as data and rendered in the signal picker so the two empty Gojiberry
 * categories show *why* they are empty and what turns them on, rather than
 * being quietly missing. Prices are list prices at the time of writing and will
 * drift; treat them as an order of magnitude, not a quote.
 */
export const PAID_PROVIDER_CATALOGUE: {
  key: string;
  label: string;
  unlocks: string;
  note: string;
}[] = [
  {
    key: "linkedin_engagement",
    label: "LinkedIn engagement",
    unlocks:
      "People at a target company who liked, commented on or shared content " +
      "about your topics — and the same for your competitors' posts.",
    note:
      "Needs a paid LinkedIn data API. The official Marketing Developer " +
      "Platform does not expose third-party post engagement; the practical " +
      "options are licensed resellers, which price per lookup.",
  },
  {
    key: "linkedin_jobs",
    label: "LinkedIn job changes",
    unlocks:
      "A decision-maker starting a new role — the highest-converting outbound " +
      "moment there is, and one the trade register only shows for statutory " +
      "officers.",
    note:
      "Partly available free today: `contact_job_change` already fires from " +
      "ONRC representative diffs for administrators. A paid feed extends it to " +
      "everyone else.",
  },
  {
    key: "intent_data",
    label: "Third-party intent data",
    unlocks:
      "Companies researching your category across a publisher network, before " +
      "they ever visit your site.",
    note:
      "Bombora-style co-op data. Almost no Romanian SMB coverage — worth " +
      "revisiting only when the product sells outside RO.",
  },
];
