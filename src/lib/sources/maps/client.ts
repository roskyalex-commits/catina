import { z } from "zod";

/**
 * Google Maps business listings, via an Apify actor.
 *
 * ## Why this source at all
 *
 * The trade register is exhausted as a source of websites. Scanning all
 * 4,202,257 rows of `od_firme.csv`: **6,131 trading companies carry a website
 * in the WEB column — 0.34%**, and we already hold 5,406 of them. Importing
 * every company in Romania would add roughly 700 domains. OpenStreetMap is
 * worse: a live Overpass query returns **7,236** Romanian businesses with a
 * website, nationally, total.
 *
 * A domain is the one input the email pipeline cannot work without, so the
 * question is where else Romanian SMBs publish one. Google Business Profiles
 * are the obvious answer — a company that will not build a website still claims
 * its Maps listing — and the actor returns website, phone and address together.
 *
 * **Whether that is actually true here is unmeasured.** `npm run measure:maps`
 * exists to answer it before anything is bought or built on top. This project
 * has paid twice for skipping that step: Brave scored 8.3% on a population
 * biased toward findable companies and **0.1%** on the one that needed it.
 *
 * ## Discovery, not enrichment
 *
 * Search *category × city* and match the results back, rather than searching
 * once per company we hold. One scrape returns thousands of places for a fixed
 * fee; per-company search costs the same per result and does not scale.
 *
 * ## Cost
 *
 * $1.50–4 per 1,000 places depending on plan tier, and every account gets $5 a
 * month free with no card — roughly 3,000 places, which is far more than a
 * measurement needs. Google's own Places API returns the same fields at **$35
 * per 1,000** once the `website` field puts the request in the Enterprise SKU.
 *
 * ## The part to be honest about
 *
 * Google's terms prohibit scraping Maps. Apify does it commercially and the
 * hiQ/Bright Data line of cases supports scraping public data, but this is a
 * weaker position than ONRC and ANAF, which are open government data. Same
 * reasoning as the Proxycurl note in docs/STATUS.md. If this becomes
 * customer-facing rather than internal seed data, the official Places API is
 * the clean path and the 23× price is what that costs.
 */

const BASE = "https://api.apify.com/v2";

/**
 * The actor. Chosen for two reasons that matter more than its star rating:
 * it takes a location + search term rather than a list of URLs, and it returns
 * `website` — which is the entire point of the exercise.
 */
export const GOOGLE_MAPS_ACTOR = "compass~crawler-google-places";

const TRIGGER_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 30_000;
const MAX_POLL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;

export type MapsSearch = {
  /** What to search for, e.g. "firma de contabilitate". */
  term: string;
  /** Where, e.g. "Cluj-Napoca, Romania". */
  location: string;
  /** Google caps a single search at roughly 120 results; see `measure:maps`. */
  maxPlaces: number;
};

/** One listing, reduced to the fields that could become a lead. */
export type MapsPlace = {
  name?: string;
  website?: string;
  domain?: string;
  phone?: string;
  address?: string;
  city?: string;
  category?: string;
  placeId?: string;
  raw: Record<string, unknown>;
};

/**
 * Tolerant, because actor output shapes drift between versions and a field
 * rename must degrade one column rather than empty the whole measurement.
 */
const placeSchema = z
  .object({
    title: z.string().optional(),
    name: z.string().optional(),
    website: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    phoneUnformatted: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    categoryName: z.string().nullable().optional(),
    placeId: z.string().nullable().optional(),
    permanentlyClosed: z.boolean().nullable().optional(),
  })
  .loose();

export class ApifyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApifyError";
  }
}

/**
 * The registrable host, or undefined.
 *
 * Deliberately strict about what counts. A Maps listing's "website" is
 * routinely a Facebook page, an Instagram profile or a marketplace storefront —
 * none of which has a mail domain, so counting them as a domain would inflate
 * the one number this whole measurement exists to produce.
 */
const NOT_A_COMPANY_SITE = new Set([
  "facebook.com", "m.facebook.com", "instagram.com", "linkedin.com",
  "twitter.com", "x.com", "tiktok.com", "youtube.com", "wa.me",
  "emag.ro", "olx.ro", "google.com", "sites.google.com", "business.site",
  "wixsite.com", "blogspot.com", "wordpress.com", "linktr.ee",
]);

export function domainOfWebsite(website: string | null | undefined): string | undefined {
  if (!website?.trim()) return undefined;
  let host: string;
  try {
    const url = new URL(website.includes("://") ? website : `https://${website}`);
    host = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
  if (!host.includes(".")) return undefined;
  if (NOT_A_COMPANY_SITE.has(host)) return undefined;
  // A subdomain of a platform is still the platform's.
  for (const platform of NOT_A_COMPANY_SITE) {
    if (host.endsWith(`.${platform}`)) return undefined;
  }
  return host;
}

export function toPlace(raw: Record<string, unknown>): MapsPlace {
  const parsed = placeSchema.safeParse(raw);
  if (!parsed.success) return { raw };
  const row = parsed.data;

  const website = row.website ?? undefined;
  return {
    name: row.title ?? row.name,
    website: website ?? undefined,
    domain: domainOfWebsite(website),
    // `phoneUnformatted` is E.164-ish and joins better; the pretty one is the
    // fallback because some rows carry only that.
    phone: row.phoneUnformatted ?? row.phone ?? undefined,
    address: row.address ?? row.street ?? undefined,
    city: row.city ?? undefined,
    category: row.categoryName ?? undefined,
    placeId: row.placeId ?? undefined,
    raw,
  };
}

export class MapsClient {
  private readonly token?: string;

  /** Blank is unset — dotenv parses `KEY=` as `""`, not undefined. */
  constructor(token?: string) {
    this.token = token?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.token);
  }

  /** Remaining free credit, so a measurement can refuse to start broke. */
  async accountLimits(): Promise<{ usedUsd?: number; limitUsd?: number }> {
    const payload = (await this.request(`${BASE}/users/me/limits`)) as {
      data?: {
        current?: { monthlyUsageUsd?: number };
        limits?: { maxMonthlyUsageUsd?: number };
      };
    };
    return {
      usedUsd: payload?.data?.current?.monthlyUsageUsd,
      limitUsd: payload?.data?.limits?.maxMonthlyUsageUsd,
    };
  }

  /** Start a run. Returns the run id and the dataset the results land in. */
  async startSearch(
    searches: readonly MapsSearch[],
  ): Promise<{ runId: string; datasetId: string }> {
    if (!this.token) throw new ApifyError("APIFY_TOKEN is not set.");
    if (searches.length === 0) throw new ApifyError("Nothing to search for.");

    const input = {
      searchStringsArray: searches.map((search) => search.term),
      locationQuery: searches[0].location,
      maxCrawledPlacesPerSearch: searches[0].maxPlaces,
      language: "ro",
      // A closed business is not a prospect, and it still costs a credit.
      skipClosedPlaces: true,
      // Off. Our own crawler already extracts role and personal addresses from
      // a site — measured at 28.2% and 8.6% — and it does not cost per page.
      // Turn this on only if that comparison ever comes out the other way.
      scrapeContacts: false,
    };

    const payload = (await this.request(
      `${BASE}/acts/${GOOGLE_MAPS_ACTOR}/runs`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    )) as { data?: { id?: string; defaultDatasetId?: string } };

    const runId = payload?.data?.id;
    const datasetId = payload?.data?.defaultDatasetId;
    if (!runId || !datasetId) {
      throw new ApifyError(
        `No run id in the response: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    return { runId, datasetId };
  }

  /** `READY` | `RUNNING` | `SUCCEEDED` | `FAILED` | `ABORTED` | `TIMED-OUT`. */
  async runStatus(runId: string): Promise<string> {
    const payload = (await this.request(`${BASE}/actor-runs/${runId}`)) as {
      data?: { status?: string };
    };
    return payload?.data?.status ?? "UNKNOWN";
  }

  /**
   * Wait for a run, then return its rows.
   *
   * Bounded. A run that never finishes must not hang a measurement forever, and
   * the dataset survives on Apify's side — giving up here loses the wait, not
   * the results.
   */
  async waitForRun(
    run: { runId: string; datasetId: string },
    onTick?: (status: string, elapsedMs: number) => void,
  ): Promise<Record<string, unknown>[]> {
    const startedAt = Date.now();

    for (;;) {
      const status = await this.runStatus(run.runId);
      const elapsed = Date.now() - startedAt;
      onTick?.(status, elapsed);

      if (status === "SUCCEEDED") break;
      if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
        throw new ApifyError(`Run ${run.runId} ended as ${status}.`);
      }
      if (elapsed > MAX_POLL_MS) {
        throw new ApifyError(
          `Run ${run.runId} still ${status} after ${Math.round(elapsed / 1000)}s. ` +
            `It keeps going on their side — the dataset id is ${run.datasetId}.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const rows = await this.request(
      `${BASE}/datasets/${run.datasetId}/items?clean=true&format=json`,
    );

    // A dataset is an array. A single object means an error envelope slipped
    // through, and treating it as one row would corrupt the tally.
    if (!Array.isArray(rows)) {
      throw new ApifyError(
        `Dataset was not an array: ${JSON.stringify(rows).slice(0, 200)}`,
      );
    }
    return rows as Record<string, unknown>[];
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
    if (!this.token) throw new ApifyError("APIFY_TOKEN is not set.");

    const controller = new AbortController();
    const timeout = init?.method === "POST" ? TRIGGER_TIMEOUT_MS : POLL_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...init?.headers,
        },
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new ApifyError(
          `Apify returned ${response.status}: ${text.slice(0, 300)}`,
          response.status,
        );
      }
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof ApifyError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApifyError(`Apify did not answer within ${timeout / 1000}s.`);
      }
      throw new ApifyError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
