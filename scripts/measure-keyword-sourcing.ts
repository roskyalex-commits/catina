/**
 * Does keyword search find Romanian companies we can actually sell to?
 *
 *   npm run measure:keyword-sourcing -- --keywords "e-factura,magazin online"
 *   npm run measure:keyword-sourcing -- --keywords "..." --budget 200
 *
 * A measurement, not a feature. Two earlier spikes settled the same question
 * for company→domain and produced very different answers — name guessing found
 * 0 of 55, Brave search 6 of 250 (2.4%), the register's own website column
 * 5,400 for nothing — so the number for *topic* search is not something to
 * assume from either.
 *
 * ## What counts as a result
 *
 * A host is only worth anything if it joins to a row in `companies`. That row
 * is where the CUI, the administrator and the revenue filing live; a domain
 * without one has no route to a contact and no way to be scored. So the run
 * reports three numbers and they mean different things:
 *
 *   joinable    the host is a company we already hold — actionable today, and
 *               the honest measure of this channel
 *   new         a real .ro business we do not hold — a discovery we cannot act
 *               on, and the reason this is re-ranking rather than sourcing
 *   fresh       joinable *and* nobody has a lead for it yet — the number that
 *               decides whether this is worth wiring
 *
 * ## The budget
 *
 * Hard-capped, because Brave's free tier is 2,000 queries a month and this is a
 * spike, not a job. The cap is enforced before the loop starts rather than
 * checked inside it, so an argument slip cannot spend the month's allowance.
 */
import { createClient } from "@supabase/supabase-js";
import { BraveSearch } from "../src/lib/enrichment/domain-search";
import {
  candidateHosts,
  topicQueries,
} from "../src/lib/enrichment/keyword-search";
import { requireEnv } from "./load-env";

/** The plan's ceiling. More than this stops being a spike. */
const MAX_BUDGET = 200;
const DEFAULT_BUDGET = 60;
/** Brave's free tier is one query a second, and it 429s rather than queueing. */
const QUERY_INTERVAL_MS = 1_200;
const ID_CHUNK = 100;

/** Wire it up if a hundred queries produce at least this many fresh companies. */
const GATE_PER_100 = 15;

type Options = { keywords: string[]; budget: number; cities: string[] };

function parseArgs(argv: string[]): Options {
  const options: Options = { keywords: [], budget: DEFAULT_BUDGET, cities: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    const list = (value: string) =>
      value.split(",").map((v) => v.trim()).filter(Boolean);

    switch (argv[i]) {
      case "--keywords":
        options.keywords = list(next());
        break;
      case "--cities":
        options.cities = list(next());
        break;
      case "--budget":
        options.budget = Number(next());
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }

  if (options.keywords.length === 0) {
    throw new Error("--keywords is required, e.g. --keywords \"e-factura,ERP\"");
  }
  if (!Number.isFinite(options.budget) || options.budget < 1) {
    throw new Error("--budget must be a positive number");
  }
  if (options.budget > MAX_BUDGET) {
    throw new Error(
      `--budget is capped at ${MAX_BUDGET}. This is a spike against a 2,000/month free tier.`,
    );
  }
  return options;
}

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Known = { id: string; name: string; caen: string | null };

/** Which of these hosts we already hold, chunked so the URL stays legal. */
async function lookupCompanies(hosts: string[]): Promise<Map<string, Known>> {
  const found = new Map<string, Known>();
  for (let i = 0; i < hosts.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from("companies")
      .select("id, name, domain, caen")
      .in("domain", hosts.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`companies lookup failed: ${error.message}`);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      found.set(String(row.domain), {
        id: String(row.id),
        name: String(row.name),
        caen: (row.caen as string) ?? null,
      });
    }
  }
  return found;
}

/** Company ids that already have a lead, so "fresh" means something. */
async function companiesWithLeads(ids: string[]): Promise<Set<string>> {
  const withLeads = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db
      .from("leads")
      .select("company_id")
      .in("company_id", ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`leads lookup failed: ${error.message}`);
    for (const row of (data ?? []) as { company_id: string }[]) {
      withLeads.add(row.company_id);
    }
  }
  return withLeads;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const brave = new BraveSearch(process.env.BRAVE_SEARCH_API_KEY);
  if (!brave.isConfigured()) {
    console.error("BRAVE_SEARCH_API_KEY is not set.");
    process.exit(1);
  }

  // Built and truncated before the first request, so the budget is a promise
  // the loop cannot break.
  const queries: { keyword: string; query: string }[] = [];
  for (const keyword of options.keywords) {
    // The base shapes once, then one extra per city. Generating the full set
    // per city would spend three quarters of the budget re-running identical
    // queries and report the repeats as coverage.
    const seen = new Set<string>();
    for (const city of [undefined, ...options.cities]) {
      for (const query of topicQueries(keyword, city)) {
        if (seen.has(query)) continue;
        seen.add(query);
        queries.push({ keyword, query });
      }
    }
  }
  const planned = queries.slice(0, options.budget);

  console.log(
    `${options.keywords.length} keywords, ${queries.length} query shapes, ` +
      `running ${planned.length} (budget ${options.budget})\n`,
  );

  const hostsByKeyword = new Map<string, Set<string>>();
  const allHosts = new Set<string>();
  let spent = 0;
  let failed = 0;

  for (const { keyword, query } of planned) {
    try {
      const results = await brave.search(query);
      spent += 1;
      const hosts = candidateHosts(results);
      const bucket = hostsByKeyword.get(keyword) ?? new Set<string>();
      for (const host of hosts) {
        bucket.add(host);
        allHosts.add(host);
      }
      hostsByKeyword.set(keyword, bucket);
      process.stdout.write(
        `  ${String(spent).padStart(3)}/${planned.length}  ${hosts.length
          .toString()
          .padStart(2)} hosts  ${query.slice(0, 60)}\n`,
      );
    } catch (error) {
      failed += 1;
      console.log(`  !!  ${error instanceof Error ? error.message : error}`);
    }
    await sleep(QUERY_INTERVAL_MS);
  }

  const hosts = [...allHosts];
  const known = await lookupCompanies(hosts);
  const withLeads = await companiesWithLeads([...known.values()].map((c) => c.id));
  const fresh = [...known.entries()].filter(([, company]) => !withLeads.has(company.id));

  console.log(
    `\n${spent} queries spent${failed ? `, ${failed} failed` : ""}\n` +
      `${hosts.length} distinct non-aggregator .ro hosts\n` +
      `${known.size} joinable — already in companies, so contactable\n` +
      `${hosts.length - known.size} new — real sites we hold no registry row for, ` +
      `and therefore cannot contact\n` +
      `${fresh.length} fresh — joinable and nobody has a lead for them yet\n`,
  );

  const perHundred = spent > 0 ? (fresh.length / spent) * 100 : 0;
  console.log(
    `${perHundred.toFixed(1)} fresh companies per 100 queries ` +
      `(gate: ${GATE_PER_100})\n` +
      (perHundred >= GATE_PER_100
        ? "Above the gate — worth wiring as a sourcing path.\n"
        : "Below the gate. Keyword search re-ranks companies we already hold " +
          "rather than finding new ones, which is what the site-keyword signal " +
          "already does for free.\n"),
  );

  for (const [keyword, bucket] of hostsByKeyword) {
    const joinable = [...bucket].filter((host) => known.has(host));
    console.log(
      `  ${keyword.padEnd(24)} ${String(bucket.size).padStart(3)} hosts, ` +
        `${String(joinable.length).padStart(3)} joinable`,
    );
  }

  console.log("\nA sample of what joined:");
  for (const [host, company] of fresh.slice(0, 15)) {
    console.log(`  ${host.padEnd(32)} ${company.name.slice(0, 40)}  ${company.caen ?? "—"}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
