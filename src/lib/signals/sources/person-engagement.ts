import type { CreditLedger } from "@/lib/enrichment/ledger";
import type { PersonSignalProvider } from "../providers/types";
import type { Signal, SignalScanContext, SignalSource } from "../types";

/**
 * Person-level engagement, from whichever paid provider is connected.
 *
 * This is the one signal source in the build that spends money, so it is the
 * one that has to be careful with it. Three things happen here that a provider
 * should not be trusted to do for itself:
 *
 *  1. **Budget is checked before the call, not after.** `CreditLedger` is the
 *     same ledger the email waterfall uses; a scan that has run out is skipped,
 *     not retried into a 429. One accounting system, not two.
 *  2. **A failing provider costs its own credits and nothing else.** Each is
 *     isolated, so a vendor outage degrades this source to empty rather than
 *     failing the company's whole scan.
 *  3. **Signals without evidence are dropped.** A provider returning "this
 *     person is interested in CRM" with no link is returning a score. The
 *     product's entire claim is that a user can click through to the post, and
 *     a paid source does not get an exemption from it.
 *
 * With no provider configured — today — this reports `skipped`, which is what
 * puts a visible empty row in the signal picker instead of a silent gap.
 */

/** How far back to ask for activity. Longer windows cost more everywhere. */
const ENGAGEMENT_WINDOW_DAYS = 60;

const PERSON_SIGNAL_TYPES = new Set(["person_engaged_topic", "person_engaged_competitor"]);

export type PersonEngagementDeps = {
  providers: PersonSignalProvider[];
  /** Absent for an unmetered run; present for anything charging an org. */
  ledger?: CreditLedger;
};

export class PersonEngagementSignalSource implements SignalSource {
  readonly key = "person_engagement";
  readonly label = "People engaging with your market";
  readonly description =
    "Decision-makers who engaged publicly with content about your topics, or " +
    "with a competitor's. Requires a connected LinkedIn data provider — no " +
    "free source publishes this.";

  constructor(private readonly deps: PersonEngagementDeps) {}

  isApplicable(context: SignalScanContext): boolean {
    if (this.deps.providers.length === 0) return false;
    if ((context.people?.length ?? 0) === 0) return false;
    return (
      (context.keywords?.length ?? 0) > 0 || (context.competitorNames?.length ?? 0) > 0
    );
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const request = {
      company: {
        name: context.company.name,
        domain: context.company.domain,
        linkedinUrl: context.company.linkedinUrl,
      },
      people: context.people ?? [],
      topics: context.keywords ?? [],
      competitors: context.competitorNames ?? [],
      since: new Date(Date.now() - ENGAGEMENT_WINDOW_DAYS * 86_400_000),
    };

    const signals: Signal[] = [];

    for (const provider of this.deps.providers) {
      if (!provider.isConfigured()) continue;

      const ledger = this.deps.ledger;
      if (ledger && !(await ledger.hasBudget(provider.key, provider.costPerCompany))) {
        continue;
      }

      try {
        const found = await provider.fetchSignals(request);
        // Spend on the attempt, not on the result. A vendor charges for a
        // lookup that comes back empty, and pretending otherwise is how a
        // ledger drifts from the invoice.
        await ledger?.spend(provider.key, provider.costPerCompany);
        signals.push(...found.filter(usable));
      } catch {
        // The vendor still billed us for a call that errored downstream of
        // their meter; charging here keeps the ledger conservative.
        await ledger?.spend(provider.key, provider.costPerCompany);
      }
    }

    return signals;
  }
}

/** Every signal must be attributable to a person and clickable to a source. */
function usable(signal: Signal): boolean {
  return (
    PERSON_SIGNAL_TYPES.has(signal.type) &&
    Boolean(signal.evidenceUrl) &&
    Boolean(signal.personLinkedinUrl)
  );
}
