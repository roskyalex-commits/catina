import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnafGrowthSignalSource,
  AnafStatusSignalSource,
  NewRegistrationSignalSource,
  parseRomanianDate,
} from "./anaf";
import { categorise, mentionsCompany, parseRssItems } from "./news";
import { extractJobTitles, isPlausibleJobTitle } from "./hiring";
import type { AnafClient } from "@/lib/sources/anaf/client";
import type { SignalScanContext } from "../types";
import type { SourcedCompany } from "@/lib/sources/types";

const company: SourcedCompany = {
  dedupeKey: "cui:12345678",
  name: "Firma Test SRL",
  domain: "firma.ro",
  country: "RO",
  cui: "12345678",
  source: "anaf",
};

function context(overrides: Partial<SignalScanContext> = {}): SignalScanContext {
  return { company, ...overrides };
}

afterEach(() => vi.unstubAllGlobals());

describe("AnafGrowthSignalSource", () => {
  function client(growth: unknown): AnafClient {
    return { fetchRevenueGrowth: vi.fn(async () => growth) } as unknown as AnafClient;
  }

  it("emits a growth signal scaled to the size of the jump", async () => {
    const source = new AnafGrowthSignalSource(
      client({
        latest: { year: 2025, revenueRon: 5_000_000 },
        previous: { year: 2024, revenueRon: 2_500_000 },
        growthRatio: 1,
      }),
    );

    const [signal] = await source.scan(context());
    expect(signal.type).toBe("anaf_revenue_growth");
    expect(signal.title).toContain("100%");
    expect(signal.strength).toBeGreaterThan(0.8);
    expect(signal.evidenceUrl).toContain("12345678");
  });

  it("emits a decline signal as a distinct type", async () => {
    const source = new AnafGrowthSignalSource(
      client({
        latest: { year: 2025, revenueRon: 700_000 },
        previous: { year: 2024, revenueRon: 1_000_000 },
        growthRatio: -0.3,
      }),
    );

    const [signal] = await source.scan(context());
    expect(signal.type).toBe("anaf_revenue_decline");
  });

  it("ignores ordinary year-to-year movement", async () => {
    // Below ±15% is noise; emitting it would bury companies that actually moved.
    const source = new AnafGrowthSignalSource(
      client({
        latest: { year: 2025, revenueRon: 1_050_000 },
        previous: { year: 2024, revenueRon: 1_000_000 },
        growthRatio: 0.05,
      }),
    );
    expect(await source.scan(context())).toEqual([]);
  });

  it("emits nothing when a year is unfiled", async () => {
    // A missing filing is an absence of information, not a collapse.
    const source = new AnafGrowthSignalSource(client(null));
    expect(await source.scan(context())).toEqual([]);
  });

  it("is not applicable without a CUI", () => {
    const source = new AnafGrowthSignalSource(client(null));
    expect(
      source.isApplicable(context({ company: { ...company, cui: undefined } })),
    ).toBe(false);
  });

  it("keys the signal on the filing year so a rescan doesn't duplicate it", async () => {
    const source = new AnafGrowthSignalSource(
      client({
        latest: { year: 2025, revenueRon: 5_000_000 },
        previous: { year: 2024, revenueRon: 2_500_000 },
        growthRatio: 1,
      }),
    );

    const [a] = await source.scan(context());
    const [b] = await source.scan(context());
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

describe("AnafStatusSignalSource", () => {
  function client(registry: unknown): AnafClient {
    return { lookupOne: vi.fn(async () => registry) } as unknown as AnafClient;
  }

  it("flags an inactive taxpayer with a stable key", async () => {
    const source = new AnafStatusSignalSource(
      client({ cui: "12345678", inactive: true, inactiveSince: "2025-11-02" }),
    );

    const [signal] = await source.scan(context());
    expect(signal.type).toBe("insolvency_risk");
    // Not date-keyed: being inactive is one ongoing fact, and re-keying per
    // scan would stack duplicate distress signals.
    expect(signal.dedupeKey).toBe("anaf_inactive:12345678");
  });

  it("emits a VAT signal only on a change", async () => {
    const source = new AnafStatusSignalSource(
      client({ cui: "12345678", vatRegistered: true, inactive: false }),
    );

    const changed = await source.scan(
      context({ previous: { vatRegistered: false } }),
    );
    expect(changed.map((s) => s.type)).toContain("vat_registered");

    // Steady-state registration says nothing about timing.
    const steady = await source.scan(context({ previous: { vatRegistered: true } }));
    expect(steady).toEqual([]);

    const firstScan = await source.scan(context());
    expect(firstScan).toEqual([]);
  });

  it("emits nothing when the company is not found", async () => {
    const source = new AnafStatusSignalSource(client(null));
    expect(await source.scan(context())).toEqual([]);
  });
});

describe("NewRegistrationSignalSource", () => {
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("flags a recently incorporated company, strongest when freshest", async () => {
    const source = new NewRegistrationSignalSource(120);

    const [fresh] = await source.scan(
      context({ company: { ...company, registrationDate: daysAgo(5) } }),
    );
    const [older] = await source.scan(
      context({ company: { ...company, registrationDate: daysAgo(100) } }),
    );

    expect(fresh.type).toBe("newly_registered");
    expect(fresh.strength).toBeGreaterThan(older.strength);
  });

  it("ignores companies outside the window", async () => {
    const source = new NewRegistrationSignalSource(120);
    const result = await source.scan(
      context({ company: { ...company, registrationDate: daysAgo(400) } }),
    );
    expect(result).toEqual([]);
  });

  it("ignores an unparseable date rather than guessing", async () => {
    const source = new NewRegistrationSignalSource();
    const result = await source.scan(
      context({ company: { ...company, registrationDate: "sometime in 2024" } }),
    );
    expect(result).toEqual([]);
  });
});

describe("parseRomanianDate", () => {
  it("parses ISO and Romanian formats", () => {
    // ANAF returns different formats by endpoint and record age.
    expect(parseRomanianDate("2024-03-15")?.toISOString()).toContain("2024-03-15");
    expect(parseRomanianDate("15.03.2024")?.toISOString()).toContain("2024-03-15");
    expect(parseRomanianDate("15/03/2024")?.toISOString()).toContain("2024-03-15");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    // new Date would silently turn 31.02 into 02 March.
    expect(parseRomanianDate("31.02.2024")).toBeNull();
    expect(parseRomanianDate("15.13.2024")).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parseRomanianDate("")).toBeNull();
    expect(parseRomanianDate("not a date")).toBeNull();
  });
});

describe("news — mentionsCompany", () => {
  it("matches when every distinctive token is present", () => {
    expect(
      mentionsCompany("Banca Transilvania raises 100M", "Banca Transilvania SA"),
    ).toBe(true);
  });

  it("rejects a partial match on a common word", () => {
    // The precision case: "Banca" alone must not match Banca Transilvania.
    expect(mentionsCompany("Banca Nationala announces rates", "Banca Transilvania SA")).toBe(
      false,
    );
  });

  it("ignores legal-form suffixes when matching", () => {
    expect(mentionsCompany("SmartBill launches new product", "SmartBill SRL")).toBe(
      true,
    );
  });

  it("does not let a generic name match everything", () => {
    // "Digital SRL" reduces to "digital" — which appears everywhere. It still
    // requires the token, so an unrelated headline is rejected.
    expect(mentionsCompany("Local bakery opens second store", "Digital SRL")).toBe(
      false,
    );
  });

  it("matches through diacritics", () => {
    expect(mentionsCompany("Vanzari record pentru Farmacia Tei", "Farmacia Tei")).toBe(
      true,
    );
    expect(mentionsCompany("Rezultate bune la Fabrica de Cânepă", "Fabrica de Canepa")).toBe(
      true,
    );
  });

  it("returns false when the name has no distinctive tokens", () => {
    expect(mentionsCompany("anything at all", "SRL")).toBe(false);
  });
});

describe("news — categorise", () => {
  it("recognises funding in English and Romanian", () => {
    expect(categorise("Startup raises $5M in Series A")).toBe("funding");
    expect(categorise("Compania a atras o finanțare de 2 milioane")).toBe("funding");
  });

  it("recognises expansion", () => {
    expect(categorise("Company opens new office in Cluj")).toBe("expansion");
    expect(categorise("Firma se extinde in Transilvania")).toBe("expansion");
  });

  it("prefers funding when a headline is both", () => {
    // "raises funding to expand" is a funding story.
    expect(categorise("Raises funding to expand into Germany")).toBe("funding");
  });

  it("returns null for unrelated news", () => {
    expect(categorise("CEO shares thoughts on remote work")).toBeNull();
  });
});

describe("news — parseRssItems", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>SmartBill raises &amp;euro;3M</title>
      <link>https://example.com/a</link>
      <pubDate>Mon, 01 Jun 2026 08:00:00 GMT</pubDate>
      <source url="https://zf.ro">Ziarul Financiar</source>
      <guid>guid-a</guid>
    </item>
    <item>
      <title><![CDATA[Firma se extinde]]></title>
      <link>https://example.com/b</link>
      <pubDate>Tue, 02 Jun 2026 08:00:00 GMT</pubDate>
    </item>
  </channel></rss>`;

  it("extracts items including CDATA and entities", () => {
    const items = parseRssItems(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "SmartBill raises &euro;3M",
      link: "https://example.com/a",
      source: "Ziarul Financiar",
      guid: "guid-a",
    });
    expect(items[1].title).toBe("Firma se extinde");
  });

  it("skips items with an unparseable date", () => {
    const bad = `<rss><item><title>T</title><link>https://x</link><pubDate>nonsense</pubDate></item></rss>`;
    expect(parseRssItems(bad)).toEqual([]);
  });

  it("returns an empty list for an empty or malformed feed", () => {
    expect(parseRssItems("")).toEqual([]);
    expect(parseRssItems("<rss><channel></channel></rss>")).toEqual([]);
  });
});

describe("hiring — job title extraction", () => {
  it("accepts titles and rejects navigation and prose", () => {
    // Over-extraction turns nav links into phantom job openings.
    expect(isPlausibleJobTitle("Senior Backend Engineer")).toBe(true);
    expect(isPlausibleJobTitle("Director de Marketing")).toBe(true);
    expect(isPlausibleJobTitle("Contabil Sef")).toBe(true);

    expect(isPlausibleJobTitle("Cookie Policy")).toBe(false);
    expect(isPlausibleJobTitle("About us")).toBe(false);
    expect(isPlausibleJobTitle("Apply now")).toBe(false);
    expect(isPlausibleJobTitle("Hi")).toBe(false);
  });

  it("rejects a sentence that happens to contain a job word", () => {
    expect(
      isPlausibleJobTitle(
        "We are looking for a talented engineer to join our growing team.",
      ),
    ).toBe(false);
  });

  it("pulls titles out of headings and links", () => {
    const html = `
      <nav><a href="/">Home</a><a href="/privacy">Privacy Policy</a></nav>
      <main>
        <h3>Senior Frontend Developer</h3>
        <ul>
          <li><a href="/j/1">Marketing Manager</a></li>
          <li><a href="/j/2">Contabil Sef</a></li>
          <li><a href="/j/3">Read more</a></li>
        </ul>
      </main>
      <footer><a href="/terms">Terms</a></footer>`;

    const titles = extractJobTitles(html);
    expect(titles).toContain("Senior Frontend Developer");
    expect(titles).toContain("Marketing Manager");
    expect(titles).toContain("Contabil Sef");
    expect(titles).not.toContain("Read more");
    expect(titles).not.toContain("Privacy Policy");
  });

  it("ignores nav and footer entirely", () => {
    const html = `<nav><a>Engineering Manager</a></nav><footer><a>Sales Director</a></footer>`;
    expect(extractJobTitles(html)).toEqual([]);
  });
});
