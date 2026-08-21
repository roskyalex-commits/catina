import { z } from "zod";

/**
 * Client for FirmeAPI.ro's contact endpoint.
 *
 * One endpoint, deliberately. `/firma/{cui}` costs 1 credit and returns name,
 * address, CAEN, VAT status and registration state — all of which ANAF already
 * gives us for free, and ANAF is the more truthful source for CAEN because it
 * is what the company actually files under. Paying for it would be paying to
 * duplicate a column.
 *
 * `/datecontact/{cui}` costs 5 credits and is the only thing here we cannot get
 * elsewhere: it aggregates telephone, email, website and named contact persons
 * across five channels. Phone is no longer interesting — ANAF turned out to be
 * returning `telefon` all along, and 98.2% of companies now carry one for free
 * — so what is actually being bought is **website**, and secondarily the named
 * contacts with their roles.
 *
 * ## The number that decides whether this is worth a subscription
 *
 * The vendor quotes 40% website coverage across ~3M Romanian companies. That
 * figure cannot be applied to us: companies that publish a website are exactly
 * the ones whose website ONRC already lists, and we already hold 31.5%. What
 * matters is the *marginal* yield on the companies we have no domain for, which
 * is a different and certainly smaller number.
 *
 * The same mistake has already been made once here with Brave — 8.3% measured
 * on companies that already had a domain, 0.1% on the ones that needed one. So
 * `scripts/measure-firme.ts` runs against the domainless population, on the
 * 1,000 free credits, before any money is spent.
 *
 * Response parsing is lenient in the ANAF style: every field optional, unknown
 * keys pass through, so an upstream rename degrades one column rather than
 * throwing the batch away. The shape below is coded from FirmeAPI's published
 * documentation and has **not** been observed against the live API.
 */

const BASE_URL = "https://www.firmeapi.ro/api/v1";
/** What one `/datecontact` call costs, per the published pricing. */
export const CONTACT_CREDIT_COST = 5;
const REQUEST_TIMEOUT_MS = 15_000;
/** Politeness, and cheap insurance against a per-second cap we cannot see. */
const MIN_REQUEST_INTERVAL_MS = 250;

/**
 * Unwrap the response envelope, if there is one.
 *
 * An unauthenticated probe returns `{"success":false,"error":"Unauthenticated",…}`,
 * so this API wraps its payloads — a success is almost certainly
 * `{success: true, data: {…}}` rather than the bare object the published
 * examples show.
 *
 * That distinction decides whether the measurement is worth anything. A parser
 * expecting the bare shape would fail on every response, `fetchContact` would
 * return null each time, the tally would count 200 misses, and the report would
 * say 0% coverage — and we would drop a vendor for a bug in our own client.
 * Accepting both shapes costs one line and removes that failure mode entirely.
 */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["data", "result", "firma", "company"]) {
      const inner = record[key];
      if (inner && typeof inner === "object") return inner;
    }
  }
  return payload;
}

/**
 * One value or many, accepted either way.
 *
 * The documented examples show arrays, but a single-valued field arriving as a
 * bare string is the commonest shape difference there is, and it would fail the
 * parse for the whole company. Since a parse failure reads as "no data" in the
 * tally, being strict here would cost coverage the vendor actually has.
 */
const listOfStrings = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((value) => (typeof value === "string" ? [value] : (value ?? [])));

const contactSchema = z
  .object({
    cui: z.union([z.number(), z.string()]).optional(),
    telefon: listOfStrings,
    email: listOfStrings,
    website: listOfStrings,
    fax: listOfStrings,
    persoane_contact: z
      .array(
        z
          .object({
            nume: z.string().optional(),
            // `functie` is at least as likely as `rol` for a Romanian API, and
            // the role is the field the job-title question turns on — losing it
            // to a name mismatch would answer that question wrongly.
            rol: z.string().optional(),
            functie: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

export type FirmeContactPerson = { name: string; role?: string };

export type FirmeContact = {
  cui: string;
  phones: string[];
  emails: string[];
  websites: string[];
  people: FirmeContactPerson[];
};

export class FirmeApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FirmeApiError";
  }
}

/** Normalise a returned site to the bare host, the shape `companies.domain` holds. */
export function toDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.replace(/^www\./, "");
    // A "website" with no dot is a typo or a placeholder, not a host.
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

export class FirmeApiClient {
  private readonly apiKey?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private creditsSpent = 0;
  private unparsed = 0;
  private lastRaw: unknown = null;

  /** Blank is unset — dotenv parses `KEY=` as `""`, not undefined. */
  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** Credits this client has spent, for reporting against the free allowance. */
  spent(): number {
    return this.creditsSpent;
  }

  /**
   * Responses that came back 200 but did not match the expected shape.
   *
   * Non-zero means the field names have moved and every number in the report is
   * wrong — a distinct failure from "the vendor has no data", and the one that
   * would otherwise be invisible.
   */
  unparsedCount(): number {
    return this.unparsed;
  }

  /** The last raw payload, for `--probe`: see the shape before trusting a tally. */
  lastPayload(): unknown {
    return this.lastRaw;
  }

  /**
   * Contact channels for one company.
   *
   * Returns null when the vendor has no record, which is a real answer and not
   * an error — the caller counts it as a miss rather than retrying.
   */
  async fetchContact(cui: string): Promise<FirmeContact | null> {
    if (!this.apiKey) {
      throw new FirmeApiError("FIRMEAPI_KEY is not set.");
    }

    const raw = await this.enqueue(`${BASE_URL}/datecontact/${encodeURIComponent(cui)}`);
    if (raw === null) return null;

    this.lastRaw = raw;
    const parsed = contactSchema.safeParse(unwrap(raw));
    if (!parsed.success) {
      /*
       * Counted, not swallowed. A renamed field must not stop a 200-company
       * run — but it must not look like the vendor having no data either, or
       * the report says 0% coverage and we drop a vendor over our own parser.
       * `unparsed()` lets the caller see the difference.
       */
      this.unparsed += 1;
      return null;
    }

    const data = parsed.data;
    return {
      cui: String(data.cui ?? cui),
      phones: clean(data.telefon),
      emails: clean(data.email).map((value) => value.toLowerCase()),
      websites: clean(data.website),
      people: (data.persoane_contact ?? [])
        .map((person) => ({
          name: (person.nume ?? "").trim(),
          role: (person.rol ?? person.functie)?.trim() || undefined,
        }))
        .filter((person) => person.name.length > 0),
    };
  }

  /** Serialised, so a bulk pass cannot open 200 sockets at a hosted API. */
  private enqueue(url: string): Promise<unknown> {
    const next = this.queue.then(async () => {
      const result = await this.fetchJson(url);
      await sleep(MIN_REQUEST_INTERVAL_MS);
      return result;
    });
    // Keep the chain alive after a rejection, or one failure stops every
    // request queued behind it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        headers: { "X-API-KEY": this.apiKey as string, accept: "application/json" },
        signal: controller.signal,
      });

      // Charged whether or not the company was found — assume the worst for
      // budgeting, so the report never understates what a run cost.
      this.creditsSpent += CONTACT_CREDIT_COST;

      if (response.status === 404) return null;
      if (response.status === 402 || response.status === 429) {
        throw new FirmeApiError(
          `FirmeAPI refused the call (${response.status}) — credits exhausted or rate limited.`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new FirmeApiError(
          `FirmeAPI returned ${response.status} ${response.statusText}`,
          response.status,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof FirmeApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new FirmeApiError(`FirmeAPI request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new FirmeApiError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function clean(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
