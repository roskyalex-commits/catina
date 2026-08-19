/**
 * Finds websites for companies the register has no domain for.
 *
 *   npm run discover:domains -- --search --limit 50 --dry-run
 *   npm run discover:domains -- --search --limit 500
 *   npm run discover:domains -- --measure --limit 60   # is search worth it?
 *   npm run discover:domains -- --limit 50             # name guessing (dead)
 *
 * ONRC carries a website for about 1% of companies. A domain is the only input
 * the email pipeline is short of — enrichment converts at 26% once it has one —
 * so this script is, in effect, the top of the email funnel.
 *
 * Two candidate sources, one verifier:
 *
 *   1a. **search** (`--search`): ask Brave for the company. Costs a query from
 *       a 2,000/month free tier.
 *   1b. **name guessing** (default): derive candidates from the company name.
 *       Kept for reference and **measured dead** — 0 of 55 on the live run.
 *       A Romanian company's legal name is frequently not its brand, and no
 *       string manipulation recovers an association that is not in the string.
 *   2.  a DNS lookup to discard candidates that do not exist
 *   3.  fetch the page and look for the company's **CUI**
 *
 * Step 3 is what makes either source safe. A Romanian company must publish its
 * fiscal code on its own website, so finding that exact number is proof of
 * ownership. Without it, "the domain looks like the name" would happily
 * attribute a squatter's parking page — or a competitor — to your prospect,
 * and a wrong domain is worse than none: it poisons the email guess, the tech
 * stack and every signal derived from them.
 *
 * `--measure` answers "is search worth the quota" before spending it in bulk:
 * it runs against companies whose domain we **already know** from the register
 * and reports how often search proposes the right one. Recall measured this way
 * is the honest ceiling for the bulk run.
 */
import { createClient } from "@supabase/supabase-js";
import {
  candidateDomains,
  isGuessable,
  pageMentionsCui,
  pageMentionsName,
  verifyDomain,
} from "@/lib/enrichment/domain-guess";
import {
  BraveSearch,
  candidatesFromResults,
  searchQueries,
} from "@/lib/enrichment/domain-search";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;
const DOH = "https://cloudflare-dns.com/dns-query";
/** Brave's free tier is one query per second; exceeding it returns 429. */
const BRAVE_PACE_MS = 1100;
/** UUIDs per `in()` — a few hundred makes a URL PostgREST refuses. */
const ID_CHUNK = 100;

type Options = {
  limit?: number;
  dryRun: boolean;
  county?: string;
  /** Take candidates from a search engine instead of the company name. */
  search: boolean;
  /** Only companies that are already somebody's lead. */
  leadsOnly: boolean;
  /** Score the candidate source against domains we already know. */
  measure: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, search: false, measure: false, leadsOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--county":
        options.county = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--search":
        options.search = true;
        break;
      case "--leads":
        options.leadsOnly = true;
        break;
      case "--measure":
        options.measure = true;
        options.search = true;
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

/** Does this domain exist at all? One cheap lookup before any page fetch. */
async function resolves(domain: string): Promise<boolean> {
  try {
    const response = await fetch(`${DOH}?name=${encodeURIComponent(domain)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { Status?: number; Answer?: unknown[] };
    return body.Status === 0 && Array.isArray(body.Answer) && body.Answer.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch a candidate's home page.
 *
 * Failures are ordinary here — most guesses are wrong, and a wrong guess shows
 * up as a timeout, a certificate error or a 404. None of that is worth logging.
 */
/**
 * Pages a Romanian company puts its fiscal code on.
 *
 * Measured over 60 companies whose real domain the register already carries:
 * the home page alone proves 5 of the 44 that are reachable, and adding
 * `/contact` takes it to 9. Nearly double, for one extra fetch on the
 * candidates that would otherwise have been discarded.
 */
const PROOF_PATHS = ["/", "/contact", "/termeni-si-conditii"];

async function fetchPage(domain: string, path = "/"): Promise<string | null> {
  for (const url of [`https://${domain}${path}`, `http://${domain}${path}`]) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          // Identify honestly. A crawler that lies about who it is deserves
          // whatever blocking it gets.
          "user-agent": "CatinaBot/0.1 (+https://catina.ro/bot; registry domain discovery)",
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) continue;
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("html")) continue;
      // A home page beyond this is a download, not a page worth scanning.
      return (await response.text()).slice(0, 500_000);
    } catch {
      /* try the next scheme */
    }
  }
  return null;
}

/**
 * Does this domain prove it belongs to the company with this fiscal code?
 *
 * The home page first, then the pages a Romanian company actually prints its
 * CUI on. Stops at the first proof, and gives up immediately if the home page
 * is unreachable — the deeper paths cannot exist if the site does not.
 *
 * Returns the home page too, so a caller that wants a weaker signal (a name
 * match, recorded but never accepted) does not have to fetch it twice.
 */
async function provesOwnership(
  domain: string,
  cui: string,
): Promise<{ home: string | null; cuiFound: boolean }> {
  let home: string | null = null;

  for (const path of PROOF_PATHS) {
    const page = await fetchPage(domain, path);
    if (path === "/") {
      home = page;
      if (page === null) return { home: null, cuiFound: false };
    }
    if (page && pageMentionsCui(page, cui)) return { home, cuiFound: true };
  }
  return { home, cuiFound: false };
}

type Company = { id: string; name: string; cui: string; county?: string | null };

const brave = new BraveSearch(process.env.BRAVE_SEARCH_API_KEY);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Candidate domains for a company, from whichever source is selected.
 *
 * Search is serialised and paced: Brave's free tier is one query per second,
 * and the concurrency that makes the DNS and fetch steps fast is exactly what
 * trips it. Only the first query is run per company unless it yields nothing —
 * 2,000 queries a month does not stretch to three per company.
 */
async function candidatesFor(
  company: Company,
  options: Options,
): Promise<{ domain: string }[]> {
  if (!options.search) return candidateDomains(company.name);

  for (const query of searchQueries(company)) {
    let results;
    try {
      results = await brave.search(query);
    } catch (error) {
      console.error(`\n  search failed for ${company.name}: ${error instanceof Error ? error.message : error}`);
      return [];
    }
    await sleep(BRAVE_PACE_MS);

    const candidates = candidatesFromResults(results, 4);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

type Found = {
  id: string;
  name: string;
  domain: string;
  confidence: number;
  reason: string;
};

async function discover(company: Company, options: Options): Promise<Found | null> {
  const distinctiveName = isGuessable(company.name);
  // Name guessing needs a distinctive name to build from. Search does not —
  // that is the entire point of using it.
  if (!options.search && !distinctiveName) return null;

  for (const candidate of await candidatesFor(company, options)) {
    if (!(await resolves(candidate.domain))) continue;

    const proof = await provesOwnership(candidate.domain, company.cui);

    const verdict = verifyDomain(
      {
        reachable: proof.home !== null,
        cuiOnPage: proof.cuiFound,
        nameOnPage: proof.home ? pageMentionsName(proof.home, company.name) : false,
      },
      { distinctiveName },
    );

    if (verdict.accepted) {
      return {
        id: company.id,
        name: company.name,
        domain: candidate.domain,
        confidence: verdict.confidence,
        reason: verdict.reason,
      };
    }
  }
  return null;
}

/** Run `worker` over `items`, at most `CONCURRENCY` at a time. */
async function pooled<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  onDone: (done: number) => void,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        results.push(await worker(item));
        onDone((done += 1));
      }
    }),
  );
  return results;
}

/**
 * Does search actually propose the right domain?
 *
 * Runs against companies whose website the register already gave us, so the
 * answer is known before the query is sent. That is the only honest way to
 * size this: the bulk run has nothing to check itself against, and "it found
 * 200 domains" says nothing about how many of them are right.
 *
 * Reports two numbers, and they mean different things:
 *   - **recall**: the known domain was among the candidates. This is the
 *     ceiling — the CUI check can only ever confirm what search proposed.
 *   - **CUI-provable**: the known domain also publishes its fiscal code, so
 *     the verifier would have accepted it. This is what the bulk run yields.
 *
 * The gap between them is companies with a real site that does not display a
 * CUI. Those are lost, and deliberately: accepting them means accepting
 * squatters and competitors too.
 */
async function measure(options: Options) {
  const { data, error } = await db
    .from("companies")
    .select("id, name, cui, county, domain")
    .not("domain", "is", null)
    .not("cui", "is", null)
    .limit(options.limit ?? 40);

  if (error) {
    console.error(`Could not read companies: ${error.message}`);
    process.exit(1);
  }
  const known = (data ?? []) as (Company & { domain: string })[];
  console.log(
    `Measuring against ${known.length} companies whose domain the register ` +
      `already carries.\n` +
      `Each costs at least one Brave query from the 2,000/month free tier.\n`,
  );

  let proposed = 0;
  let provable = 0;

  for (const [index, company] of known.entries()) {
    const candidates = await candidatesFor(company, options);
    const hit = candidates.some(
      (candidate) => candidate.domain === company.domain.replace(/^www\./, ""),
    );
    if (hit) {
      proposed += 1;
      const proof = await provesOwnership(company.domain, company.cui);
      if (proof.cuiFound) provable += 1;
    }
    process.stdout.write(
      `\r  checked ${index + 1}/${known.length}, ${proposed} proposed, ${provable} provable`,
    );
  }

  const pct = (n: number) => ((n / known.length) * 100).toFixed(1);
  console.log(
    `\n\nRecall:       ${proposed}/${known.length} (${pct(proposed)}%) — search proposed the right domain\n` +
      `CUI-provable: ${provable}/${known.length} (${pct(provable)}%) — and the verifier would accept it\n\n` +
      `The second number is what a bulk run yields. Name guessing, for\n` +
      `comparison, was 47% recall and 0 accepted on the live run.\n`,
  );
}

/** Companies with no domain yet. Paged: PostgREST caps a select at 1,000. */
async function companiesWithoutDomain(options: Options): Promise<Company[]> {
  const companies: Company[] = [];

  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit
      ? Math.min(PAGE, options.limit - companies.length)
      : PAGE;
    if (wanted <= 0) break;

    let query = db
      .from("companies")
      .select("id, name, cui, county")
      .is("domain", null)
      .not("cui", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + wanted - 1);
    if (options.county) query = query.eq("county", options.county);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as Company[];
    companies.push(...page);
    if (page.length < wanted) break;
  }
  return companies;
}

/**
 * Companies somebody is actually trying to reach, and which have no domain.
 *
 * Brave's free tier is 2,000 queries a month and 11,457 companies have no
 * domain, so a full pass is six years of quota. The leads are where a domain
 * becomes an email today.
 *
 * The leads are read **first** and the companies fetched from them, rather than
 * loading companies and filtering. Filtering afterwards makes `--limit` cap the
 * wrong set: `--limit 250` took the first 250 companies in the register, found
 * 11 of them were leads, and searched those — which is not what anyone asking
 * for 250 meant.
 */
async function leadCompanies(options: Options): Promise<Company[]> {
  const companyIds = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("leads")
      .select("company_id")
      .is("email_id", null)
      .order("score", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`Could not read leads: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as { company_id: string }[];
    for (const row of page) companyIds.add(row.company_id);
    if (page.length < PAGE) break;
  }

  // Chunked: several hundred UUIDs in one `in()` is a URL PostgREST rejects.
  const ids = [...companyIds];
  const companies: Company[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    let query = db
      .from("companies")
      .select("id, name, cui, county")
      .is("domain", null)
      .not("cui", "is", null)
      .in("id", ids.slice(i, i + ID_CHUNK));
    if (options.county) query = query.eq("county", options.county);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    companies.push(...((data ?? []) as Company[]));
  }

  console.log(
    `${companyIds.size} leads are waiting on an address; ` +
      `${companies.length} of their companies have no domain to work from
`,
  );
  // The limit belongs here, after the set is known — see the note above.
  return options.limit ? companies.slice(0, options.limit) : companies;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.search && !brave.isConfigured()) {
    console.error(
      "BRAVE_SEARCH_API_KEY is not set. Get a free key at\n" +
        "  https://brave.com/search/api/  (2,000 queries/month, commercial use allowed)\n" +
        "then add it to .env.local.",
    );
    process.exit(1);
  }
  if (options.measure) return measure(options);

  const companies = options.leadsOnly
    ? await leadCompanies(options)
    : await companiesWithoutDomain(options);

  // Search works from the company as an entity, so a generic name is no
  // obstacle to it — only name guessing needs a distinctive string.
  const attempted = options.search
    ? companies
    : companies.filter((company) => isGuessable(company.name));

  console.log(
    `${companies.length} companies without a domain\n` +
      (options.search
        ? `searching for all ${attempted.length}, ~1 Brave query each\n`
        : `${attempted.length} have a name distinctive enough to guess from ` +
          `(${companies.length - attempted.length} too generic — skipped)\n`),
  );
  if (attempted.length === 0) return;

  const run = (company: Company) => discover(company, options);
  const found = (
    options.search
      ? // Serial: Brave's free tier is one query per second, and the pool that
        // makes DNS and page fetches fast is what would trip it.
        await (async () => {
          const results: (Found | null)[] = [];
          for (const [index, company] of attempted.entries()) {
            results.push(await run(company));
            process.stdout.write(`\r  checked ${index + 1}/${attempted.length}`);
          }
          return results;
        })()
      : await pooled(attempted, run, (done) => {
          if (done % 10 === 0 || done === attempted.length) {
            process.stdout.write(`\r  checked ${done}/${attempted.length}`);
          }
        })
  ).filter((result): result is Found => result !== null);

  console.log(
    `\n\nProved ${found.length} domains by CUI — ` +
      `${((found.length / attempted.length) * 100).toFixed(1)}% of those attempted.\n` +
      (options.search
        ? "Anything the CUI check rejected is not recorded: a wrong domain\n" +
          "poisons the email guess and every signal derived from it.\n"
        : "Expect this to be low. See docs/STATUS.md: a Romanian company's legal\n" +
          "name is frequently not its brand, and most small firms have no site.\n"),
  );

  for (const result of found.slice(0, 15)) {
    console.log(
      `  ${result.domain.padEnd(30)} ${result.name.slice(0, 32).padEnd(34)} ${result.reason}`,
    );
  }

  if (options.dryRun) {
    console.log("\nDry run — nothing was written.");
    return;
  }

  // `companies.domain` is unique, so a domain already claimed by another
  // company is left alone rather than failing the batch.
  let written = 0;
  let contested = 0;
  for (const result of found) {
    const { data: existing } = await db
      .from("companies")
      .select("id")
      .eq("domain", result.domain)
      .maybeSingle();

    if (existing && (existing as { id: string }).id !== result.id) {
      contested += 1;
      continue;
    }

    const { error } = await db
      .from("companies")
      .update({ domain: result.domain, website: `https://${result.domain}` })
      .eq("id", result.id);
    if (error) {
      console.error(`\n  ${result.domain}: ${error.message}`);
      continue;
    }
    written += 1;
  }

  console.log(
    `\n✓ Wrote ${written} domains` +
      (contested ? `, ${contested} already claimed by another company` : ""),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
