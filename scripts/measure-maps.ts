/**
 * Is Google Maps worth using as a source of company websites? Measured on the
 * free credits, before anything is bought or built on top.
 *
 *   npm run measure:maps -- --probe                      # 1 search, dump a raw row
 *   npm run measure:maps -- --city "Cluj-Napoca" --limit 100
 *
 * Every Apify account gets $5 of platform credit a month with no card, and the
 * Google Maps actor charges roughly $1.50–4 per 1,000 places. A measurement is
 * a few hundred places, so this is free.
 *
 * ## Why the question is open at all
 *
 * The register is exhausted as a source of websites: scanning all 4,202,257
 * rows of `od_firme.csv`, **6,131 trading companies carry one — 0.34%** — and
 * we already hold 5,406. OpenStreetMap answers 7,236 nationally. A domain is
 * the single input the email pipeline cannot work without, and 90% of leads are
 * skipped for not having one.
 *
 * So either Google Business Profiles carry websites that the register does not,
 * or the domain ceiling needs a different answer entirely. Nobody knows which,
 * and this settles it for the price of nothing.
 *
 * ## The four numbers, in order, and why they are not one number
 *
 * **1. Places returned per search.** Google caps a single query at roughly 120
 * results. If that cap binds, national coverage means many (category × city)
 * runs rather than a few, and the cost model changes.
 *
 * **2. Of those, how many carry a website.** The headline. A Facebook page is
 * not a website — there is no mail domain behind one — so `domainOfWebsite`
 * refuses platform hosts, and a run that counted them would inflate exactly the
 * number this exists to produce.
 *
 * **3. How many join back to a company we already hold.** A website with no
 * CUI beside it is not a lead: no administrator, no financials, no signals.
 * Phone is the primary key at 95.2% uniqueness; see `match.ts`.
 *
 * **4. Of the joins, how many are companies we have NO domain for.** This is
 * the number that decides. Everything else can look excellent and the exercise
 * still be pointless if Maps only knows the companies whose websites we already
 * had — which is precisely how the Brave measurement went wrong: 8.3% on
 * companies that already had a domain, **0.1%** on the ones that needed one.
 */
import { createClient } from "@supabase/supabase-js";
import {
  ApifyError,
  MapsClient,
  toPlace,
  type MapsPlace,
} from "../src/lib/sources/maps/client";
import { RegistryIndex, type RegistryCompany } from "../src/lib/sources/maps/match";
import { requireEnv } from "./load-env";

const DEFAULT_LIMIT = 100;
const PAGE = 1000;

/**
 * Search terms, in Romanian, because the listings are.
 *
 * Chosen to span the professional-services slice the register import targets
 * rather than to be exhaustive — the point is a coverage rate, and a rate does
 * not need every category.
 */
const DEFAULT_TERMS = [
  "firma de contabilitate",
  "agentie de marketing",
  "firma de software",
  "birou de avocatura",
  "firma de consultanta",
];

type Options = {
  city: string;
  county: string;
  terms: string[];
  limit: number;
  probe: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    city: "Cluj-Napoca",
    county: "Cluj",
    terms: DEFAULT_TERMS,
    limit: DEFAULT_LIMIT,
    probe: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--city":
        options.city = next();
        break;
      case "--county":
        options.county = next();
        break;
      case "--term":
        options.terms = [next()];
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--probe":
        options.probe = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const maps = new MapsClient(process.env.APIFY_TOKEN);

/** Every company we hold in the county being searched. */
async function loadRegistry(county: string): Promise<RegistryCompany[]> {
  const rows: RegistryCompany[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("companies")
      .select("id, name, county, phone, domain")
      .eq("county", county)
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`companies: ${error.message}`);
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(
      ...batch.map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        county: (row.county as string) ?? null,
        phone: (row.phone as string) ?? null,
        domain: (row.domain as string) ?? null,
      })),
    );
    if (batch.length < PAGE) break;
  }
  return rows;
}

function pct(part: number, total: number): string {
  if (total === 0) return "   0 (  0.0%)";
  return `${String(part).padStart(4)} (${((part / total) * 100).toFixed(1).padStart(5)}%)`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!maps.isConfigured()) {
    console.error(
      "APIFY_TOKEN is not set.\n\n" +
        "  Create a free account at https://apify.com — no card, $5 of platform\n" +
        "  credit every month, which is about 3,000 Google Maps places. Then\n" +
        "  Settings -> Integrations -> API token, and put it in .env.local as\n" +
        "  APIFY_TOKEN.",
    );
    process.exit(1);
  }

  try {
    const limits = await maps.accountLimits();
    if (limits.usedUsd !== undefined && limits.limitUsd !== undefined) {
      console.log(
        `Apify credit: $${limits.usedUsd.toFixed(2)} used of $${limits.limitUsd.toFixed(2)}\n`,
      );
    }
  } catch {
    // Not fatal — the run itself will fail loudly enough if the token is bad.
  }

  const terms = options.probe ? options.terms.slice(0, 1) : options.terms;
  const maxPlaces = options.probe ? 5 : options.limit;

  console.log(
    `Searching Google Maps: ${terms.length} term(s) in ${options.city}, ` +
      `up to ${maxPlaces} places each.\n`,
  );

  let rows: Record<string, unknown>[];
  try {
    const run = await maps.startSearch(
      terms.map((term) => ({
        term,
        location: `${options.city}, Romania`,
        maxPlaces,
      })),
    );
    console.log(`run ${run.runId} -> dataset ${run.datasetId}`);

    rows = await maps.waitForRun(run, (status, elapsed) => {
      process.stdout.write(`\r  ${status}, ${Math.round(elapsed / 1000)}s   `);
    });
  } catch (error) {
    console.error(
      `\n${error instanceof ApifyError ? error.message : String(error)}\n\n` +
        `  A 404 on the actor means the id changed — check apify.com for the\n` +
        `  current Google Maps scraper before trusting anything this prints.`,
    );
    process.exit(1);
  }
  console.log(`\n  ${rows.length} places returned\n`);

  const places: MapsPlace[] = rows.map(toPlace);

  if (options.probe) {
    /*
     * Look at one raw row before trusting a tally. Every field name here is
     * coded from the actor's documentation, and a mismatch would report 0% with
     * a website — which reads exactly like "Romanian SMBs have no websites" and
     * would kill the idea for entirely the wrong reason.
     */
    console.log("raw first row:");
    console.log(JSON.stringify(rows[0] ?? null, null, 2).slice(0, 2500));
    console.log("\nparsed by our client:");
    console.log(JSON.stringify(places[0] ?? null, null, 2).slice(0, 1000));
    return;
  }

  const registry = await loadRegistry(options.county);
  const index = new RegistryIndex(registry);
  const stats = index.phoneStats();
  console.log(
    `Registry side: ${registry.length} companies in ${options.county}, ` +
      `${stats.unique}/${stats.distinct} phone numbers unique to one company\n`,
  );

  let withWebsite = 0;
  let withDomain = 0;
  let withPhone = 0;
  let joined = 0;
  let joinedByPhone = 0;
  let newDomain = 0;
  const samples: string[] = [];

  for (const place of places) {
    if (place.website) withWebsite += 1;
    if (place.domain) withDomain += 1;
    if (place.phone) withPhone += 1;

    const verdict = index.match({
      name: place.name,
      phone: place.phone,
      county: options.county,
    });
    if (!verdict.matched) continue;

    joined += 1;
    if (verdict.by === "phone") joinedByPhone += 1;

    const company = registry.find((c) => c.id === verdict.companyId);
    if (place.domain && company && !company.domain) {
      newDomain += 1;
      if (samples.length < 12) {
        samples.push(
          `  ${(company.name ?? "").slice(0, 32).padEnd(34)} ${place.domain.padEnd(28)} ${verdict.by}`,
        );
      }
    }
  }

  const total = places.length;
  console.log(`Of ${total} places returned:\n`);
  console.log(`  1. carry any website link      ${pct(withWebsite, total)}`);
  console.log(`     ...a real domain, not a     ${pct(withDomain, total)}`);
  console.log(`        Facebook or eMAG page`);
  console.log(`  2. carry a phone number        ${pct(withPhone, total)}`);
  console.log(`  3. join to a company we hold   ${pct(joined, total)}`);
  console.log(`     ...of those, by phone       ${pct(joinedByPhone, Math.max(joined, 1))}`);
  console.log(`  4. AND we had no domain for it ${pct(newDomain, total)}   <- the number`);

  if (samples.length) {
    console.log(`\nDomains this would newly attach:`);
    for (const sample of samples) console.log(sample);
  }

  console.log(`\n${"-".repeat(66)}\n`);

  /*
   * The verdict in the terms the decision is actually made in. At $1.50–4 per
   * 1,000 places, what matters is euros per newly reachable company, not any of
   * the percentages above on their own.
   */
  const perThousand = 3; // mid-range of the $1.50–4 tier spread
  if (newDomain === 0) {
    console.log(
      `No new domains at all. Either Maps does not know these companies, or it\n` +
        `only knows the ones whose websites we already had. Check number 3: a\n` +
        `low join rate is a matching problem and worth fixing; a high join rate\n` +
        `with no new domains means there is nothing here to buy.`,
    );
    return;
  }

  const costPerDomain = (perThousand / 1000 / (newDomain / total)).toFixed(3);
  console.log(
    `${((newDomain / total) * 100).toFixed(1)}% of places produced a domain for a company we could not\n` +
      `previously reach — about $${costPerDomain} per new domain at $${perThousand}/1,000 places.\n\n` +
      `Against the funnel's own measured rates, 1,000 new domains yield roughly\n` +
      `282 role addresses and 86 personal ones before any verification spend.`,
  );

  if (newDomain / total < 0.02) {
    console.log(
      `\n  Below 2% this is not worth the plumbing. Before concluding that,\n` +
        `  re-read number 3 — the join, not the source, is the usual culprit.`,
    );
  }
}

main();
