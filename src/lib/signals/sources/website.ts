import type { Signal, SignalScanContext, SignalSource } from "../types";
import {
  fetchSiteSnapshot,
  SiteFetchError,
  type SiteSnapshot,
} from "@/lib/crawl/fetch-site";

/**
 * The company's site, from the scan's shared reader when there is one.
 *
 * Both sources in this file need the same page. Fetching it twice cost twelve
 * HTTP requests per company for two signals, so `context.site` memoises one read
 * across every source in a scan. The direct fetch stays as the fallback for
 * callers that build a context by hand — the tests do, and so would anyone
 * running a single source.
 */
async function siteFor(context: SignalScanContext): Promise<SiteSnapshot | null> {
  if (context.site) return context.site();
  const domain = context.company.domain;
  if (!domain) return null;
  try {
    return await fetchSiteSnapshot(domain);
  } catch (error) {
    // An unreachable site is not a change. Emitting one would fire a signal
    // every time a site had an outage.
    if (error instanceof SiteFetchError) return null;
    throw error;
  }
}

/**
 * Signals from diffing a company's own website between scans.
 *
 * Free, and it reuses the crawler onboarding already needs. A tech-stack
 * change is a strong buying signal — a company that just added Stripe or
 * migrated off Magento is actively spending on that category right now.
 */

export class TechStackSignalSource implements SignalSource {
  readonly key = "tech_stack";
  readonly label = "Technology changes";
  readonly description =
    "Detects when a company adopts or drops a platform. Migrating stacks means " +
    "budget is moving in that category right now.";

  /**
   * Technologies whose adoption implies real spend. Adding one of these is a
   * much stronger signal than picking up an analytics tag.
   */
  private static readonly HIGH_INTENT = new Set([
    "Shopify", "Magento", "WooCommerce", "PrestaShop", "Gomag", "MerchantPro",
    "Stripe", "Netopia", "EuPlatesc", "HubSpot", "Klaviyo", "Intercom",
    "Segment", "SmartBill",
  ]);

  isApplicable(context: SignalScanContext): boolean {
    // Needs a previous scan to diff against — the first scan only records.
    return Boolean(context.company.domain && context.previous?.techStack);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const domain = context.company.domain;
    const previous = context.previous?.techStack;
    if (!domain || !previous) return [];

    const snapshot = await siteFor(context);
    if (!snapshot) return [];
    const current = snapshot.techStack;

    const added = current.filter((t) => !previous.includes(t));
    const removed = previous.filter((t) => !current.includes(t));
    const detectedAt = new Date();
    const evidenceUrl = `https://${domain}`;
    const signals: Signal[] = [];
    const period = detectedAt.toISOString().slice(0, 10);

    if (added.length > 0) {
      const notable = added.filter((t) => TechStackSignalSource.HIGH_INTENT.has(t));
      signals.push({
        type: "tech_stack_added",
        title: `Started using ${added.join(", ")}`,
        evidenceUrl,
        strength: notable.length > 0 ? 0.8 : 0.4,
        detectedAt,
        dedupeKey: `tech_added:${domain}:${added.sort().join(",")}`,
        payload: { added, notable, period },
      });
    }

    if (removed.length > 0) {
      const notable = removed.filter((t) => TechStackSignalSource.HIGH_INTENT.has(t));
      signals.push({
        type: "tech_stack_removed",
        title: `Stopped using ${removed.join(", ")}`,
        evidenceUrl,
        // Dropping a paid platform means they are switching to something —
        // possibly you.
        strength: notable.length > 0 ? 0.75 : 0.3,
        detectedAt,
        dedupeKey: `tech_removed:${domain}:${removed.sort().join(",")}`,
        payload: { removed, notable, period },
      });
    }

    return signals;
  }
}

/**
 * Pricing-page changes.
 *
 * A repriced or repositioned pricing page usually precedes a push, and it is
 * a natural hook for outreach that clearly isn't a mass mailing.
 */
export class PricingPageSignalSource implements SignalSource {
  readonly key = "pricing_page";
  readonly label = "Pricing page changes";
  readonly description =
    "Flags when a company changes its pricing or packaging — often the run-up " +
    "to a bigger push.";

  isApplicable(context: SignalScanContext): boolean {
    return Boolean(context.company.domain && context.previous?.pricingPageHash);
  }

  async scan(context: SignalScanContext): Promise<Signal[]> {
    const domain = context.company.domain;
    const previousHash = context.previous?.pricingPageHash;
    if (!domain || !previousHash) return [];

    const snapshot = await siteFor(context);
    if (!snapshot) return [];

    const pricingPage = snapshot.pages.find((p) => /pricing|preturi|tarife/i.test(p.url));
    if (!pricingPage) return [];

    const currentHash = await hashText(pricingPage.text);
    if (currentHash === previousHash) return [];

    const detectedAt = new Date();
    return [
      {
        type: "pricing_page_changed",
        title: "Pricing page changed",
        evidenceUrl: pricingPage.url,
        strength: 0.5,
        detectedAt,
        dedupeKey: `pricing:${domain}:${currentHash.slice(0, 12)}`,
        // The URL travels with the hash so the next scan can persist both and
        // diff the same page rather than whichever one matched first.
        payload: { previousHash, currentHash, pricingPageUrl: pricingPage.url },
      },
    ];
  }
}

/**
 * Stable content hash.
 *
 * Uses WebCrypto because it is the only hashing available in Workers — no
 * node:crypto. Whitespace is collapsed first so a reflow or a reformatted
 * template doesn't read as a pricing change.
 */
export async function hashText(text: string): Promise<string> {
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
