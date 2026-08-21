import { z } from "zod";

/**
 * Bright Data's LinkedIn people scraper, over the Web Scraper API.
 *
 * ## Which Bright Data product this is, because there are two
 *
 * The **Datasets** product sells bulk LinkedIn data (~$250 per 100K records,
 * delivered to S3). It has free *samples* but no free tier. The **Web Scraper
 * API** used here gives every account 5,000 free credits a month with no card,
 * and is URL-in / JSON-out.
 *
 * We hold zero LinkedIn URLs, so the only usable entry point is *discovery by
 * name* — which we can do because ONRC gives us 29,551 real names attached to
 * real companies.
 *
 * ## Why buying the dataset is the eventual answer and this is the test
 *
 * Discovery by name is inherently ambiguous: "Popescu Ion" matches many people,
 * and picking the wrong one puts a stranger's job title and LinkedIn URL on a
 * lead. `current_company` is the only disambiguator we have, and it is why this
 * client returns the raw company name rather than deciding matches itself —
 * the matching rule belongs next to the data we are matching against.
 *
 * ## Legal footing
 *
 * Buying from Bright Data rather than scraping ourselves is the decision.
 * Proxycurl was shut down in July 2025 after LinkedIn sued; Bright Data holds
 * ISO 27001 and SOC 2, offers GDPR DPAs, and is the only scraping company to
 * have won in US courts on this question (Meta and X, 2024). That is the
 * strongest available position, not a guarantee.
 *
 * ## What the probe established, on a real key
 *
 * The field shapes below are now **observed**, not documented: a control run
 * against a known profile returned `name`, `first_name`, `last_name`,
 * `position`, `current_company` (an object with `name`), `current_company_name`,
 * `city`, `country_code` and `url`. `toProfile` maps them correctly.
 *
 * **But discovery is not available.** Triggering with `type=discover_new` on
 * either live collector — LinkedIn people profiles or LinkedIn company
 * information — returns `400 Incorrect discovery collector id. Available
 * types:` with the list *empty*. Every other LinkedIn dataset on the account
 * answers `This dataset does not support collection`: those are marketplace
 * datasets, bought in bulk rather than triggered.
 *
 * So on the free tier this client can only scrape profiles whose URLs we
 * already hold, and we hold none. Two things were checked before concluding
 * that:
 *
 *   - Company websites do not supply them. Of 40 mid-market sites crawled,
 *     **zero** linked a single `linkedin.com/in/` profile — though four in five
 *     did link their `linkedin.com/company/` page. Romanian companies of this
 *     size publish a corporate presence, not their staff.
 *   - The SERP API, which shares the same free credits and could find profile
 *     URLs by search, needs a zone created in the dashboard first:
 *     `/status` reports `can_make_requests: false, zone_not_found`.
 *
 * The client is kept because it is correct and the blocker is account-level,
 * not code. It becomes useful the moment there is a source of profile URLs.
 */

const BASE = "https://api.brightdata.com/datasets/v3";
/** LinkedIn people profiles. */
export const PEOPLE_DATASET_ID = "gd_l1viktl72bvl7bjuj0";
const TRIGGER_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 30_000;
/** Discovery runs asynchronously; this is how long we wait for one batch. */
const MAX_POLL_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;

export type DiscoverByName = { firstName: string; lastName: string };

/**
 * One returned profile, reduced to what we would actually store.
 *
 * Everything optional: a scraped profile is whatever the person chose to fill
 * in, and a missing headline must degrade one field rather than drop the row.
 */
export type BrightDataProfile = {
  url?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  /** The headline or current position — the field this whole exercise is for. */
  title?: string;
  currentCompany?: string;
  location?: string;
  countryCode?: string;
  raw: Record<string, unknown>;
};

const profileSchema = z
  .object({
    url: z.string().optional(),
    input_url: z.string().optional(),
    linkedin_url: z.string().optional(),
    name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    position: z.string().optional(),
    headline: z.string().optional(),
    title: z.string().optional(),
    city: z.string().optional(),
    location: z.string().optional(),
    country_code: z.string().optional(),
    // Bright Data returns this as an object on some datasets and a string on
    // others; both appear in their own examples.
    current_company: z
      .union([z.string(), z.object({ name: z.string().optional() }).loose()])
      .optional(),
    current_company_name: z.string().optional(),
  })
  .loose();

export class BrightDataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BrightDataError";
  }
}

/** Pull a company name out of whichever shape came back. */
function companyOf(row: z.infer<typeof profileSchema>): string | undefined {
  if (typeof row.current_company === "string") return row.current_company.trim() || undefined;
  if (row.current_company && typeof row.current_company === "object") {
    const name = (row.current_company as { name?: string }).name;
    if (name?.trim()) return name.trim();
  }
  return row.current_company_name?.trim() || undefined;
}

export function toProfile(raw: Record<string, unknown>): BrightDataProfile {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) return { raw };
  const row = parsed.data;

  return {
    url: row.url ?? row.linkedin_url ?? row.input_url,
    name: row.name,
    firstName: row.first_name,
    lastName: row.last_name,
    // `position` is the current job title; `headline` is the free-text line
    // people write themselves. Position first — it is the structured one.
    title: row.position ?? row.title ?? row.headline,
    currentCompany: companyOf(row),
    location: row.location ?? row.city,
    countryCode: row.country_code,
    raw,
  };
}

export class BrightDataClient {
  private readonly apiKey?: string;
  private lastRaw: unknown = null;

  /** Blank is unset — dotenv parses `KEY=` as `""`, not undefined. */
  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** The last payload seen, for `--probe`: confirm the shape before trusting a tally. */
  lastPayload(): unknown {
    return this.lastRaw;
  }

  /**
   * Start a discovery run for a batch of names.
   *
   * Async because discovery is only available that way — the synchronous
   * `/scrape` endpoint takes URLs, which we do not have.
   */
  async triggerNameDiscovery(people: readonly DiscoverByName[]): Promise<string> {
    if (!this.apiKey) throw new BrightDataError("BRIGHTDATA_API_KEY is not set.");
    if (people.length === 0) throw new BrightDataError("Nothing to discover.");

    const url =
      `${BASE}/trigger?dataset_id=${PEOPLE_DATASET_ID}` +
      `&type=discover_new&discover_by=name&include_errors=true`;

    const body = people.map((person) => ({
      first_name: person.firstName,
      last_name: person.lastName,
    }));

    const payload = (await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as { snapshot_id?: string };

    if (!payload?.snapshot_id) {
      throw new BrightDataError(
        `No snapshot_id in the trigger response: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    return payload.snapshot_id;
  }

  /** `starting` | `running` | `ready` | `failed`. */
  async progress(snapshotId: string): Promise<string> {
    const payload = (await this.request(`${BASE}/progress/${snapshotId}`)) as {
      status?: string;
    };
    return payload?.status ?? "unknown";
  }

  /**
   * Wait for a snapshot, then return its rows.
   *
   * Bounded: a run that never finishes must not hang a measurement forever, and
   * the snapshot survives on their side for days, so giving up here loses
   * nothing but the wait.
   */
  async waitForSnapshot(
    snapshotId: string,
    onTick?: (status: string, elapsedMs: number) => void,
  ): Promise<Record<string, unknown>[]> {
    const startedAt = Date.now();

    for (;;) {
      const status = await this.progress(snapshotId);
      const elapsed = Date.now() - startedAt;
      onTick?.(status, elapsed);

      if (status === "ready") break;
      if (status === "failed") {
        throw new BrightDataError(`Snapshot ${snapshotId} failed.`);
      }
      if (elapsed > MAX_POLL_MS) {
        throw new BrightDataError(
          `Snapshot ${snapshotId} still ${status} after ${Math.round(elapsed / 1000)}s. ` +
            `It keeps running on their side — re-check with the snapshot id.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const rows = await this.request(`${BASE}/snapshot/${snapshotId}?format=json`);
    this.lastRaw = rows;

    // A snapshot is an array; a single object means an error envelope slipped
    // through, and treating it as one row would corrupt the tally.
    if (!Array.isArray(rows)) {
      throw new BrightDataError(
        `Snapshot was not an array: ${JSON.stringify(rows).slice(0, 200)}`,
      );
    }
    return rows as Record<string, unknown>[];
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
    if (!this.apiKey) throw new BrightDataError("BRIGHTDATA_API_KEY is not set.");

    const controller = new AbortController();
    const timeout = init?.method === "POST" ? TRIGGER_TIMEOUT_MS : POLL_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...init?.headers,
        },
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new BrightDataError(
          `Bright Data returned ${response.status}: ${text.slice(0, 300)}`,
          response.status,
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        /*
         * A ready snapshot can come back as NDJSON even when `format=json` was
         * asked for. Parsing line by line costs nothing and avoids reporting a
         * successful run as a client failure.
         */
        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return lines.map((line) => JSON.parse(line));
      }
    } catch (error) {
      if (error instanceof BrightDataError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new BrightDataError(`Bright Data did not answer within ${timeout / 1000}s.`);
      }
      throw new BrightDataError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
