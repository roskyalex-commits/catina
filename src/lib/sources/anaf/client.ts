import { z } from "zod";

/**
 * Client for ANAF's public company-registry API (webservicesp.anaf.ro).
 *
 * Free, no API key, no account. This is the backbone of the Romanian lead
 * engine and the reason the MVP has no data cost: it returns official name,
 * address, trade-register number, CAEN activity code, VAT status, e-Factura
 * status and inactive/insolvency flags for any of ~4M Romanian companies.
 *
 * Two hard constraints from ANAF, both enforced below:
 *   - at most 100 CUIs per request
 *   - roughly 1 request/second; exceeding it gets the caller throttled
 *
 * Response parsing is deliberately lenient. Every field is optional and unknown
 * keys pass through, so an upstream rename degrades one column instead of
 * throwing away the whole batch. Run `npm run verify:anaf` against the live API
 * to confirm the field names below — this sandbox has no egress to ANAF, so
 * they are coded from ANAF's published v9 shape rather than an observed one.
 */

const BASE_URL = "https://webservicesp.anaf.ro";
const MAX_CUIS_PER_REQUEST = 100;
const MIN_REQUEST_INTERVAL_MS = 1_100;
const REQUEST_TIMEOUT_MS = 15_000;

/** ANAF nests its payload; every branch is optional because inactive or
 *  deregistered companies omit whole sections. */
const dateGeneraleSchema = z
  .object({
    cui: z.union([z.number(), z.string()]).optional(),
    denumire: z.string().optional(),
    adresa: z.string().optional(),
    nrRegCom: z.string().optional(),
    telefon: z.string().optional(),
    codPostal: z.string().optional(),
    stare_inregistrare: z.string().optional(),
    data_inregistrare: z.string().optional(),
    cod_CAEN: z.string().optional(),
    iban: z.string().optional(),
    statusRO_e_Factura: z.boolean().optional(),
    forma_juridica: z.string().optional(),
    forma_organizare: z.string().optional(),
  })
  .loose();

const found = z
  .object({
    date_generale: dateGeneraleSchema.optional(),
    inregistrare_scop_Tva: z
      .object({ scpTVA: z.boolean().optional() })
      .loose()
      .optional(),
    inregistrare_RTVAI: z
      .object({ statusTvaIncasare: z.boolean().optional() })
      .loose()
      .optional(),
    stare_inactiv: z
      .object({
        statusInactivi: z.boolean().optional(),
        dataInactivare: z.string().optional(),
      })
      .loose()
      .optional(),
    adresa_sediu_social: z
      .object({
        sdenumire_Localitate: z.string().optional(),
        sdenumire_Judet: z.string().optional(),
        sdenumire_Strada: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const tvaResponseSchema = z
  .object({
    cod: z.number().optional(),
    message: z.string().optional(),
    found: z.array(found).default([]),
    notFound: z.array(z.unknown()).default([]),
  })
  .loose();

/** One indicator row from the annual financial statement. */
const bilantIndicator = z
  .object({
    indicator: z.string().optional(),
    val_indicator: z.number().optional(),
    val_den_indicator: z.string().optional(),
  })
  .loose();

const bilantResponseSchema = z
  .object({
    cui: z.union([z.number(), z.string()]).optional(),
    an: z.union([z.number(), z.string()]).optional(),
    deni: z.string().optional(),
    caen: z.union([z.number(), z.string()]).optional(),
    i: z.array(bilantIndicator).default([]),
  })
  .loose();

export type AnafCompany = {
  cui: string;
  name?: string;
  address?: string;
  city?: string;
  county?: string;
  regCom?: string;
  caen?: string;
  phone?: string;
  postalCode?: string;
  /** ANAF's `stare_inregistrare`, e.g. "INREGISTRAT". */
  registrationState?: string;
  registrationDate?: string;
  vatRegistered?: boolean;
  vatOnCollection?: boolean;
  eFacturaRegistered?: boolean;
  /** True when ANAF lists the company in the inactive-taxpayer register. */
  inactive?: boolean;
  inactiveSince?: string;
  legalForm?: string;
};

export type AnafFinancials = {
  cui: string;
  year: number;
  name?: string;
  caen?: string;
  /** Raw indicator map, keyed by ANAF's indicator code (I13, I18, …). */
  indicators: Record<string, number>;
  revenueRon?: number;
  profitRon?: number;
  employees?: number;
};

/**
 * ANAF indicator codes for the fields we care about.
 *
 * These vary by reporting form, so the label-based fallback in
 * `extractFinancials` is the reliable path and this map is the fast path.
 * Confirm both against live output with `npm run verify:anaf`.
 */
const INDICATOR_CODES = {
  revenue: ["I13", "I20"],
  profit: ["I18", "I19"],
  employees: ["I20", "I22"],
} as const;

export type CacheLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export class AnafError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AnafError";
  }
}

/** Strips spaces and a leading "RO" so callers can pass a VAT number verbatim. */
export function normaliseCui(input: string | number): string | null {
  const digits = String(input)
    .trim()
    .replace(/^ro/i, "")
    .replace(/\s+/g, "");
  // Romanian CUIs are 2-10 digits. Anything else is a typo, not a company.
  return /^\d{2,10}$/.test(digits) ? digits : null;
}

export class AnafClient {
  private lastRequestAt = 0;
  /** In-flight serialisation, so concurrent callers still respect the interval. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cache?: CacheLike,
    private readonly cacheTtlSeconds = 60 * 60 * 24 * 7,
  ) {}

  /** Serialises requests and spaces them by ANAF's ~1/s limit. */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const waitMs = MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      this.lastRequestAt = Date.now();
      return fn();
    });
    // Keep the chain alive even when one call rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...init?.headers,
        },
      });
      /*
       * 404 means "no such taxpayer", not "the service is broken".
       *
       * Observed against the live API, which is the only way this could have
       * been known: ANAF answers a lookup for an unregistered CUI with a 404
       * rather than an empty `found` array. Treating that as an error made a
       * single unknown CUI throw — fatal when enriching thousands of registry
       * rows, a meaningful share of which are no longer registered for tax.
       *
       * Null propagates as "nothing found" and the callers already handle it.
       */
      if (response.status === 404) return null;

      if (!response.ok) {
        throw new AnafError(
          `ANAF returned ${response.status} for ${url}`,
          response.status,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AnafError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AnafError(`ANAF request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new AnafError(
        `ANAF request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Look up companies by CUI. Batches into groups of 100 and caches per-CUI,
   * so a repeated lookup costs nothing against the rate limit.
   */
  async lookupByCui(cuis: (string | number)[]): Promise<AnafCompany[]> {
    const normalised = [
      ...new Set(cuis.map(normaliseCui).filter((c): c is string => c !== null)),
    ];
    if (normalised.length === 0) return [];

    const results: AnafCompany[] = [];
    const misses: string[] = [];

    for (const cui of normalised) {
      const cached = await this.cache?.get(`anaf:tva:${cui}`);
      if (cached) {
        try {
          results.push(JSON.parse(cached) as AnafCompany);
          continue;
        } catch {
          // Corrupt cache entry — fall through and refetch.
        }
      }
      misses.push(cui);
    }

    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < misses.length; i += MAX_CUIS_PER_REQUEST) {
      const batch = misses.slice(i, i + MAX_CUIS_PER_REQUEST);
      const payload = batch.map((cui) => ({ cui: Number(cui), data: today }));

      const raw = await this.schedule(() =>
        this.fetchJson(`${BASE_URL}/api/PlatitorTvaRest/v9/tva`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );

      // A 404 from `fetchJson` means none of this batch is registered for tax —
      // ordinary for registry rows, not a schema problem.
      if (raw === null) continue;

      const parsed = tvaResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AnafError(
          "ANAF response did not match the expected shape — run `npm run verify:anaf` " +
            "and update the schema in src/lib/sources/anaf/client.ts",
        );
      }

      for (const entry of parsed.data.found) {
        const company = toCompany(entry);
        if (!company) continue;
        results.push(company);
        await this.cache?.put(
          `anaf:tva:${company.cui}`,
          JSON.stringify(company),
          { expirationTtl: this.cacheTtlSeconds },
        );
      }
    }

    return results;
  }

  async lookupOne(cui: string | number): Promise<AnafCompany | null> {
    const [company] = await this.lookupByCui([cui]);
    return company ?? null;
  }

  /**
   * Annual financial statement. This is the signal no international competitor
   * has: objective, official year-over-year revenue for any Romanian company.
   */
  async fetchFinancials(
    cui: string | number,
    year: number,
  ): Promise<AnafFinancials | null> {
    const normalised = normaliseCui(cui);
    if (!normalised) return null;

    const cacheKey = `anaf:bilant:${normalised}:${year}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as AnafFinancials;
      } catch {
        // Fall through and refetch.
      }
    }

    const raw = await this.schedule(() =>
      this.fetchJson(`${BASE_URL}/bilant?an=${year}&cui=${normalised}`),
    );

    const parsed = bilantResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.i.length === 0) return null;

    const financials = extractFinancials(normalised, year, parsed.data);
    await this.cache?.put(cacheKey, JSON.stringify(financials), {
      // Filings change once a year; a long TTL is safe and saves the round trip.
      expirationTtl: 60 * 60 * 24 * 30,
    });
    return financials;
  }

  /**
   * Revenue growth between the two most recent filed years.
   *
   * Returns null when either year is missing — an absent filing is not zero
   * revenue, and treating it as such would invent a -100% growth signal.
   */
  async fetchRevenueGrowth(
    cui: string | number,
    latestYear = new Date().getFullYear() - 1,
  ): Promise<{
    latest: AnafFinancials;
    previous: AnafFinancials;
    growthRatio: number;
  } | null> {
    const latest = await this.fetchFinancials(cui, latestYear);
    const previous = await this.fetchFinancials(cui, latestYear - 1);

    if (!latest?.revenueRon || !previous?.revenueRon) return null;
    if (previous.revenueRon <= 0) return null;

    return {
      latest,
      previous,
      growthRatio: latest.revenueRon / previous.revenueRon - 1,
    };
  }
}

function toCompany(entry: z.infer<typeof found>): AnafCompany | null {
  const general = entry.date_generale;
  const cui = general?.cui !== undefined ? normaliseCui(general.cui) : null;
  if (!cui) return null;

  const address = entry.adresa_sediu_social;

  return {
    cui,
    name: general?.denumire?.trim(),
    address: general?.adresa?.trim(),
    city: address?.sdenumire_Localitate?.trim(),
    county: address?.sdenumire_Judet?.trim(),
    regCom: general?.nrRegCom?.trim(),
    caen: general?.cod_CAEN?.trim(),
    phone: general?.telefon?.trim(),
    postalCode: general?.codPostal?.trim(),
    registrationState: general?.stare_inregistrare?.trim(),
    registrationDate: general?.data_inregistrare?.trim(),
    vatRegistered: entry.inregistrare_scop_Tva?.scpTVA,
    vatOnCollection: entry.inregistrare_RTVAI?.statusTvaIncasare,
    eFacturaRegistered: general?.statusRO_e_Factura,
    inactive: entry.stare_inactiv?.statusInactivi,
    inactiveSince: entry.stare_inactiv?.dataInactivare,
    legalForm: general?.forma_juridica?.trim(),
  };
}

/**
 * Pull revenue/profit/headcount out of the indicator list.
 *
 * Tries the known indicator codes first, then falls back to matching the
 * Romanian label. The label path is what survives ANAF changing form codes
 * between reporting years.
 */
export function extractFinancials(
  cui: string,
  year: number,
  data: z.infer<typeof bilantResponseSchema>,
): AnafFinancials {
  const indicators: Record<string, number> = {};
  for (const row of data.i) {
    if (row.indicator && typeof row.val_indicator === "number") {
      indicators[row.indicator] = row.val_indicator;
    }
  }

  const byCode = (codes: readonly string[]): number | undefined => {
    for (const code of codes) {
      if (indicators[code] !== undefined) return indicators[code];
    }
    return undefined;
  };

  const byLabel = (pattern: RegExp): number | undefined => {
    const row = data.i.find(
      (r) => r.val_den_indicator && pattern.test(r.val_den_indicator),
    );
    return typeof row?.val_indicator === "number" ? row.val_indicator : undefined;
  };

  return {
    cui,
    year,
    name: data.deni?.trim(),
    caen: data.caen !== undefined ? String(data.caen) : undefined,
    indicators,
    revenueRon: byLabel(/cifra de afaceri/i) ?? byCode(INDICATOR_CODES.revenue),
    profitRon: byLabel(/profit(ul)? net/i) ?? byCode(INDICATOR_CODES.profit),
    employees: byLabel(/num[ăa]r mediu de salaria[țt]i/i) ??
      byCode(INDICATOR_CODES.employees),
  };
}
