import type { AnafClient } from "@/lib/sources/anaf/client";
import type {
  Signal,
  SignalScanContext,
  SignalSource,
} from "../types";

/**
 * Signals from the Romanian company registry.
 *
 * The most defensible sources in the product: official, free, and structurally
 * unavailable to any international prospecting tool. A revenue jump filed with
 * ANAF is objective in a way that "someone liked a competitor's LinkedIn post"
 * is not.
 *
 * All of these are Romania-only by construction.
 */

const ANAF_SEARCH_URL = "https://mfinante.gov.ro/domenii/informatii-contribuabili/persoane-juridice/info-pj-selectie-dupa-cui";

/** Evidence link for a Romanian company, so every signal is checkable. */
function evidenceUrl(cui: string): string {
  return `${ANAF_SEARCH_URL}?cui=${encodeURIComponent(cui)}`;
}

export class AnafGrowthSignalSource implements SignalSource {
  readonly key = "anaf_growth";
  readonly label = "Revenue growth (ANAF filings)";
  readonly description =
    "Year-over-year revenue change from official annual filings. Objective, " +
    "free, and unavailable to international tools.";

  constructor(private readonly client: AnafClient) {}

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.cui);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const cui = context.company.cui;
    if (!cui) return [];

    const growth = await this.client.fetchRevenueGrowth(cui);
    // Null means a year is unfiled. That is an absence of information, not a
    // collapse — emitting a decline signal here would flag every late filer.
    if (!growth) return [];

    const pct = growth.growthRatio * 100;
    const detectedAt = new Date();
    const base = {
      evidenceUrl: evidenceUrl(cui),
      detectedAt,
      payload: {
        year: growth.latest.year,
        revenueRon: growth.latest.revenueRon,
        previousRevenueRon: growth.previous.revenueRon,
        growthRatio: growth.growthRatio,
      },
    };

    // Below ±15% is ordinary year-to-year movement, not a signal. Emitting it
    // would bury the companies that genuinely moved.
    if (growth.growthRatio >= 0.15) {
      return [
        {
          ...base,
          type: "anaf_revenue_growth",
          title: `Revenue up ${pct.toFixed(0)}% to ${formatRon(growth.latest.revenueRon!)} (${growth.latest.year} filing)`,
          // Scale strength with the size of the jump, saturating at ~100%.
          strength: Math.min(1, 0.4 + growth.growthRatio / 2),
          dedupeKey: `anaf_growth:${cui}:${growth.latest.year}`,
        },
      ];
    }

    if (growth.growthRatio <= -0.15) {
      return [
        {
          ...base,
          type: "anaf_revenue_decline",
          title: `Revenue down ${Math.abs(pct).toFixed(0)}% (${growth.latest.year} filing)`,
          strength: Math.min(1, 0.3 + Math.abs(growth.growthRatio) / 2),
          dedupeKey: `anaf_decline:${cui}:${growth.latest.year}`,
        },
      ];
    }

    return [];
  }
}

/**
 * Registry status changes: VAT registration, and the inactive-taxpayer list.
 *
 * Both directions matter. A company registering for VAT has usually crossed a
 * revenue threshold and is growing; a company appearing on the inactive list
 * is in distress and should stop receiving outreach.
 */
export class AnafStatusSignalSource implements SignalSource {
  readonly key = "anaf_status";
  readonly label = "Registry status changes (VAT, insolvency)";
  readonly description =
    "New VAT registration usually means a company crossed a revenue threshold. " +
    "The inactive-taxpayer list is the earliest public distress signal.";

  constructor(private readonly client: AnafClient) {}

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.cui);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const cui = context.company.cui;
    if (!cui) return [];

    const registry = await this.client.lookupOne(cui);
    if (!registry) return [];

    const signals: Signal[] = [];
    const detectedAt = new Date();
    const url = evidenceUrl(cui);

    if (registry.inactive) {
      signals.push({
        type: "insolvency_risk",
        title: registry.inactiveSince
          ? `Listed as an inactive taxpayer since ${registry.inactiveSince}`
          : "Listed as an inactive taxpayer at ANAF",
        evidenceUrl: url,
        strength: 1,
        detectedAt,
        // Not keyed on date: the company being inactive is one ongoing fact,
        // and re-keying it per scan would stack duplicate distress signals.
        dedupeKey: `anaf_inactive:${cui}`,
        payload: { since: registry.inactiveSince },
      });
    }

    // Only a *change* is a signal. Steady-state VAT registration says nothing
    // about timing, and the previous scan is what makes it a change.
    const wasRegistered = context.previous?.vatRegistered;
    if (registry.vatRegistered && wasRegistered === false) {
      signals.push({
        type: "vat_registered",
        title: "Newly registered for VAT — usually a revenue threshold crossed",
        evidenceUrl: url,
        strength: 0.7,
        detectedAt,
        dedupeKey: `anaf_vat:${cui}:${detectedAt.toISOString().slice(0, 7)}`,
      });
    }

    return signals;
  }
}

/**
 * Recently incorporated companies.
 *
 * Reaching a founder in their first months is the highest-leverage moment for
 * anything they need to set up once — accounting, banking, invoicing, hosting.
 */
export class NewRegistrationSignalSource implements SignalSource {
  readonly key = "onrc_new";
  readonly label = "Newly registered companies";
  readonly description =
    "Companies incorporated in the last few months, from the ONRC register. " +
    "The moment founders choose the tools they'll keep for years.";

  constructor(private readonly maxAgeDays = 120) {}

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.cui && context.company.registrationDate);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const { cui, registrationDate } = context.company;
    if (!cui || !registrationDate) return [];

    const registered = parseRomanianDate(registrationDate);
    if (!registered) return [];

    const ageDays = (Date.now() - registered.getTime()) / 86_400_000;
    if (ageDays < 0 || ageDays > this.maxAgeDays) return [];

    return [
      {
        type: "newly_registered",
        title: `Incorporated ${Math.round(ageDays)} days ago`,
        evidenceUrl: evidenceUrl(cui),
        // Freshest registrations are the strongest; taper across the window.
        strength: Math.max(0.4, 1 - ageDays / this.maxAgeDays),
        // Registration is a one-off event, so the date belongs in the key.
        detectedAt: registered,
        dedupeKey: `onrc_new:${cui}`,
        payload: { registrationDate },
      },
    ];
  }
}

/**
 * ANAF returns dates in several formats depending on the endpoint and the
 * age of the record, so try the ones actually seen rather than assuming ISO.
 */
export function parseRomanianDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // ISO: 2024-03-15
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return utcDate(+iso[1], +iso[2], +iso[3]);

  // Romanian: 15.03.2024 or 15/03/2024
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(trimmed);
  if (dmy) return utcDate(+dmy[3], +dmy[2], +dmy[1]);

  return null;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates like 31.02 that Date would silently roll over.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

function formatRon(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M RON`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k RON`;
  return `${value} RON`;
}
