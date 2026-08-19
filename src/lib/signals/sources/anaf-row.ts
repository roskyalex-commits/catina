import type { Signal, SignalScanContext, SignalSource } from "../types";

/**
 * Registry signals computed from the `companies` row rather than from ANAF.
 *
 * `scripts/enrich-registry.ts` already asked ANAF for revenue, previous-year
 * revenue, VAT status and the inactive flag, and wrote them to the row — 11,438
 * companies' worth. The live sources in `anaf.ts` ask again: `fetchRevenueGrowth`
 * issues two requests, `lookupOne` a third, and `AnafClient` serialises
 * everything at ~1.1s per request.
 *
 * That is the difference between a scan bound by a rate limit (~1,000 companies
 * an hour) and one bound by nothing at all. These sources do zero HTTP, so the
 * 11,750 companies with no website — which no web source can say anything about
 * — can still be scanned, in one cheap pass over the table.
 *
 * They emit the same types, thresholds and dedupe-key shapes as the live
 * sources, so a later `--live-anaf` pass upserts over these rows rather than
 * duplicating them. Keep the two in step: if a threshold changes here it must
 * change in `anaf.ts` too, or the same company will hold two contradictory
 * signals depending on which source last ran.
 */

const ANAF_SEARCH_URL =
  "https://mfinante.gov.ro/domenii/informatii-contribuabili/persoane-juridice/info-pj-selectie-dupa-cui";

function evidenceUrl(cui: string): string {
  return `${ANAF_SEARCH_URL}?cui=${encodeURIComponent(cui)}`;
}

function formatRon(value: number): string {
  return `${new Intl.NumberFormat("ro-RO").format(Math.round(value))} RON`;
}

/** Year-over-year revenue movement, from the enriched row. Zero HTTP. */
export class AnafGrowthFromRowSource implements SignalSource {
  readonly key = "anaf_growth";
  readonly label = "Revenue growth (ANAF filings)";
  readonly description =
    "Year-over-year revenue change from official annual filings, read from the " +
    "enriched registry row rather than re-fetched.";

  isApplicable(context: SignalScanContext): boolean {
    const { cui, revenueRon, revenuePrevRon } = context.company;
    // Both years must be present *and* the previous one non-zero: dividing by a
    // zero base produces an infinite growth ratio for every company that filed
    // nothing last year, which is a lot of them.
    return Boolean(cui && revenueRon !== undefined && revenuePrevRon);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const { cui, revenueRon, revenuePrevRon, financialsYear } = context.company;
    if (!cui || revenueRon === undefined || !revenuePrevRon) return [];

    const growthRatio = (revenueRon - revenuePrevRon) / Math.abs(revenuePrevRon);
    if (!Number.isFinite(growthRatio)) return [];

    const pct = growthRatio * 100;
    const year = financialsYear ?? new Date().getUTCFullYear() - 1;
    const base = {
      evidenceUrl: evidenceUrl(cui),
      // The filing's year, not now: a 2025 filing read today is a 2025 fact, and
      // dating it now would keep it permanently fresh across every rescan.
      detectedAt: new Date(Date.UTC(year, 11, 31)),
      payload: { year, revenueRon, previousRevenueRon: revenuePrevRon, growthRatio },
    };

    // Same ±15% deadband as the live source. Below it is ordinary year-to-year
    // movement, and emitting it would bury the companies that genuinely moved.
    if (growthRatio >= 0.15) {
      return [
        {
          ...base,
          type: "anaf_revenue_growth",
          title: `Revenue up ${pct.toFixed(0)}% to ${formatRon(revenueRon)} (${year} filing)`,
          strength: Math.min(1, 0.4 + growthRatio / 2),
          dedupeKey: `anaf_growth:${cui}:${year}`,
        },
      ];
    }

    if (growthRatio <= -0.15) {
      return [
        {
          ...base,
          type: "anaf_revenue_decline",
          title: `Revenue down ${Math.abs(pct).toFixed(0)}% (${year} filing)`,
          strength: Math.min(1, 0.3 + Math.abs(growthRatio) / 2),
          dedupeKey: `anaf_decline:${cui}:${year}`,
        },
      ];
    }

    return [];
  }
}

/**
 * Distress and VAT state, from the enriched row plus the previous scan.
 *
 * `insolvencyStatus` is a standing fact and fires every scan while it holds —
 * deliberately, because the dedupe key has no date in it, so it stays one row.
 * VAT is a *change* and needs the previous scan; steady-state registration says
 * nothing about timing.
 */
export class AnafStatusFromRowSource implements SignalSource {
  readonly key = "anaf_status";
  readonly label = "Registry status changes (VAT, insolvency)";
  readonly description =
    "VAT registration and the inactive-taxpayer list, read from the enriched " +
    "registry row.";

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.cui);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const { cui, insolvencyStatus, vatRegistered } = context.company;
    if (!cui) return [];

    const signals: Signal[] = [];
    const detectedAt = new Date();
    const url = evidenceUrl(cui);

    if (insolvencyStatus) {
      signals.push({
        type: "insolvency_risk",
        title:
          insolvencyStatus === "anaf_inactive"
            ? "Listed as an inactive taxpayer at ANAF"
            : `Registry distress on record: ${insolvencyStatus}`,
        evidenceUrl: url,
        strength: 1,
        detectedAt,
        // No date in the key: being inactive is one ongoing fact, and re-keying
        // per scan would stack duplicate distress signals for the same company.
        dedupeKey: `anaf_inactive:${cui}`,
        payload: { status: insolvencyStatus },
      });
    }

    const wasRegistered = context.previous?.vatRegistered;
    if (vatRegistered && wasRegistered === false) {
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
