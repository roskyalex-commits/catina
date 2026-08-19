import { afterEach, describe, expect, it, vi } from "vitest";
import { AnafClient, AnafError, normaliseCui } from "./client";

/**
 * These tests pin the behaviour I could not verify against the live API from
 * this sandbox: batching, the rate-limit spacing, per-CUI caching, and — most
 * importantly — that a shape change degrades gracefully rather than throwing
 * away a whole batch of companies.
 */

function tvaResponse(entries: unknown[]) {
  return { cod: 200, message: "SUCCESS", found: entries, notFound: [] };
}

function company(cui: number, overrides: Record<string, unknown> = {}) {
  return {
    date_generale: {
      cui,
      denumire: `FIRMA ${cui} SRL`,
      nrRegCom: "J40/1234/2020",
      cod_CAEN: "6201",
      stare_inregistrare: "INREGISTRAT",
      statusRO_e_Factura: true,
      ...overrides,
    },
    inregistrare_scop_Tva: { scpTVA: true },
    stare_inactiv: { statusInactivi: false },
    adresa_sediu_social: {
      sdenumire_Localitate: "Cluj-Napoca",
      sdenumire_Judet: "Cluj",
    },
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("normaliseCui", () => {
  it("accepts a plain CUI", () => {
    expect(normaliseCui("14399840")).toBe("14399840");
  });

  it("strips the RO VAT prefix and whitespace", () => {
    // Users paste VAT numbers off invoices; the registry wants bare digits.
    expect(normaliseCui("RO 14399840")).toBe("14399840");
    expect(normaliseCui("ro14399840")).toBe("14399840");
  });

  it("accepts a numeric input", () => {
    expect(normaliseCui(14399840)).toBe("14399840");
  });

  it("rejects anything that is not a 2-10 digit code", () => {
    expect(normaliseCui("")).toBeNull();
    expect(normaliseCui("J40/1234/2020")).toBeNull();
    expect(normaliseCui("12345678901")).toBeNull();
    expect(normaliseCui("abc")).toBeNull();
  });
});

describe("AnafClient.lookupByCui", () => {
  it("maps the nested ANAF payload onto a flat company", async () => {
    mockFetch(() => tvaResponse([company(14399840)]));
    const client = new AnafClient();

    const [result] = await client.lookupByCui(["RO14399840"]);

    expect(result).toMatchObject({
      cui: "14399840",
      name: "FIRMA 14399840 SRL",
      caen: "6201",
      city: "Cluj-Napoca",
      county: "Cluj",
      vatRegistered: true,
      eFacturaRegistered: true,
      inactive: false,
    });
  });

  it("batches at 100 CUIs per request", async () => {
    // ANAF rejects larger batches outright, so this bound is load-bearing.
    const spy = mockFetch((_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { cui: number }[];
      expect(payload.length).toBeLessThanOrEqual(100);
      return tvaResponse(payload.map((p) => company(p.cui)));
    });

    const client = new AnafClient();
    const cuis = Array.from({ length: 250 }, (_, i) => 10_000_000 + i);
    const results = await client.lookupByCui(cuis);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(250);
  });

  it("dedupes CUIs before hitting the network", async () => {
    const spy = mockFetch((_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { cui: number }[];
      expect(payload).toHaveLength(1);
      return tvaResponse([company(14399840)]);
    });

    const client = new AnafClient();
    await client.lookupByCui(["14399840", "RO14399840", " 14399840 "]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("skips entries with no usable CUI rather than failing the batch", async () => {
    // One malformed record should cost one company, not ninety-nine.
    mockFetch(() =>
      tvaResponse([
        company(14399840),
        { date_generale: { denumire: "NO CUI SRL" } },
        company(14399841),
      ]),
    );

    const client = new AnafClient();
    const results = await client.lookupByCui([14399840, 14399841, 14399842]);
    expect(results.map((r) => r.cui)).toEqual(["14399840", "14399841"]);
  });

  it("tolerates missing optional sections", async () => {
    // Deregistered companies omit whole branches of the payload.
    mockFetch(() =>
      tvaResponse([{ date_generale: { cui: 14399840, denumire: "MINIMAL SRL" } }]),
    );

    const client = new AnafClient();
    const [result] = await client.lookupByCui([14399840]);

    expect(result.name).toBe("MINIMAL SRL");
    expect(result.vatRegistered).toBeUndefined();
    expect(result.city).toBeUndefined();
  });

  it("keeps unknown fields from breaking the parse", async () => {
    mockFetch(() =>
      tvaResponse([
        {
          ...company(14399840),
          brand_new_anaf_section: { something: true },
        },
      ]),
    );

    const client = new AnafClient();
    const [result] = await client.lookupByCui([14399840]);
    expect(result.cui).toBe("14399840");
  });

  it("raises a pointed error when the envelope shape changes", async () => {
    mockFetch(() => ({ unexpected: "payload", found: "not-an-array" }));
    const client = new AnafClient();

    await expect(client.lookupByCui([14399840])).rejects.toThrow(
      /verify:anaf/,
    );
  });

  it("surfaces HTTP failures as AnafError with the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const client = new AnafClient();
    await expect(client.lookupByCui([14399840])).rejects.toMatchObject({
      name: "AnafError",
      status: 429,
    });
  });

  it("returns early for an all-invalid input without calling the API", async () => {
    const spy = mockFetch(() => tvaResponse([]));
    const client = new AnafClient();

    expect(await client.lookupByCui(["", "abc", "J40/1/2020"])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("AnafClient caching", () => {
  function memoryCache() {
    const store = new Map<string, string>();
    return {
      store,
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
    };
  }

  it("serves a repeat lookup from cache without a second request", async () => {
    const spy = mockFetch(() => tvaResponse([company(14399840)]));
    const cache = memoryCache();
    const client = new AnafClient(cache);

    await client.lookupByCui([14399840]);
    const second = await client.lookupByCui([14399840]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(second[0].name).toBe("FIRMA 14399840 SRL");
  });

  it("only fetches the uncached CUIs in a mixed batch", async () => {
    const spy = mockFetch((_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { cui: number }[];
      return tvaResponse(payload.map((p) => company(p.cui)));
    });
    const cache = memoryCache();
    const client = new AnafClient(cache);

    await client.lookupByCui([14399840]);
    await client.lookupByCui([14399840, 14399841]);

    const secondCallPayload = JSON.parse(String(spy.mock.calls[1][1]?.body));
    expect(secondCallPayload).toEqual([
      expect.objectContaining({ cui: 14399841 }),
    ]);
  });

  it("refetches when a cache entry is corrupt", async () => {
    const spy = mockFetch(() => tvaResponse([company(14399840)]));
    const cache = memoryCache();
    cache.store.set("anaf:tva:14399840", "{ not json");

    const client = new AnafClient(cache);
    const [result] = await client.lookupByCui([14399840]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.cui).toBe("14399840");
  });
});

describe("AnafClient.fetchFinancials", () => {
  function bilant(rows: unknown[]) {
    return { cui: 14399840, an: 2025, deni: "FIRMA SRL", caen: 6201, i: rows };
  }

  it("reads revenue and profit from the Romanian indicator labels", async () => {
    // The label path is the one that survives ANAF renumbering form codes.
    mockFetch(() =>
      bilant([
        { indicator: "I13", val_indicator: 5_400_000, val_den_indicator: "Cifra de afaceri neta" },
        { indicator: "I18", val_indicator: 620_000, val_den_indicator: "Profitul net" },
        { indicator: "I20", val_indicator: 42, val_den_indicator: "Numar mediu de salariati" },
      ]),
    );

    const client = new AnafClient();
    const result = await client.fetchFinancials(14399840, 2025);

    expect(result).toMatchObject({
      cui: "14399840",
      year: 2025,
      revenueRon: 5_400_000,
      profitRon: 620_000,
      employees: 42,
    });
  });

  it("falls back to indicator codes when labels are absent", async () => {
    mockFetch(() =>
      bilant([
        { indicator: "I13", val_indicator: 900_000 },
        { indicator: "I18", val_indicator: 50_000 },
      ]),
    );

    const client = new AnafClient();
    const result = await client.fetchFinancials(14399840, 2025);

    expect(result?.revenueRon).toBe(900_000);
    expect(result?.profitRon).toBe(50_000);
  });

  it("returns null when no statement was filed", async () => {
    mockFetch(() => bilant([]));
    const client = new AnafClient();
    expect(await client.fetchFinancials(14399840, 2025)).toBeNull();
  });

  it("rejects an invalid CUI without a network call", async () => {
    const spy = mockFetch(() => bilant([]));
    const client = new AnafClient();

    expect(await client.fetchFinancials("nonsense", 2025)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("AnafClient.fetchRevenueGrowth", () => {
  function bilantFor(revenueByYear: Record<number, number | null>) {
    return (url: string) => {
      const year = Number(new URL(url).searchParams.get("an"));
      const revenue = revenueByYear[year];
      if (revenue === null || revenue === undefined) {
        return { cui: 14399840, an: year, i: [] };
      }
      return {
        cui: 14399840,
        an: year,
        i: [
          {
            indicator: "I13",
            val_indicator: revenue,
            val_den_indicator: "Cifra de afaceri neta",
          },
        ],
      };
    };
  }

  it("computes year-over-year growth", async () => {
    mockFetch(bilantFor({ 2025: 1_500_000, 2024: 1_000_000 }));
    const client = new AnafClient();

    const growth = await client.fetchRevenueGrowth(14399840, 2025);
    expect(growth?.growthRatio).toBeCloseTo(0.5);
  });

  it("reports decline as a negative ratio", async () => {
    mockFetch(bilantFor({ 2025: 800_000, 2024: 1_000_000 }));
    const client = new AnafClient();

    const growth = await client.fetchRevenueGrowth(14399840, 2025);
    expect(growth?.growthRatio).toBeCloseTo(-0.2);
  });

  it("returns null when a year is unfiled rather than inventing -100%", async () => {
    // A missing filing is not zero revenue. Treating it as such would fire a
    // false "collapsing revenue" signal on every company that files late.
    mockFetch(bilantFor({ 2025: 1_000_000, 2024: null }));
    const client = new AnafClient();

    expect(await client.fetchRevenueGrowth(14399840, 2025)).toBeNull();
  });

  it("returns null when the prior year had zero revenue", async () => {
    // Guards a division by zero that would otherwise yield Infinity.
    mockFetch(bilantFor({ 2025: 1_000_000, 2024: 0 }));
    const client = new AnafClient();

    expect(await client.fetchRevenueGrowth(14399840, 2025)).toBeNull();
  });
});

describe("AnafClient rate limiting", () => {
  it("spaces consecutive requests by at least a second", async () => {
    const timestamps: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        timestamps.push(Date.now());
        return new Response(JSON.stringify(tvaResponse([])), { status: 200 });
      }),
    );

    const client = new AnafClient();
    await client.lookupByCui([14399840]);
    await client.lookupByCui([14399841]);

    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("keeps spacing subsequent calls after one request fails", async () => {
    // A rejected promise must not break the serialisation chain, or a single
    // 429 turns into a burst that gets us throttled harder.
    let call = 0;
    const timestamps: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        timestamps.push(Date.now());
        call += 1;
        if (call === 1) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify(tvaResponse([])), { status: 200 });
      }),
    );

    const client = new AnafClient();
    await expect(client.lookupByCui([14399840])).rejects.toBeInstanceOf(AnafError);
    await client.lookupByCui([14399841]);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(1000);
  });
});
