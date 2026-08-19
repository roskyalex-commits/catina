/**
 * Finds websites for companies the register has no domain for.
 *
 *   npm run discover:domains -- --limit 50 --dry-run
 *   npm run discover:domains -- --limit 500
 *
 * ONRC carries a website for about 1% of companies, and a domain is what
 * unlocks email inference, crawling, tech-stack fingerprinting and pricing
 * signals. This closes that gap without a vendor.
 *
 * Guess, then prove:
 *
 *   1. candidate domains from the company name (pure, tested)
 *   2. a DNS lookup to discard the ones that do not exist
 *   3. fetch the page and look for the company's **CUI**
 *
 * Step 3 is what makes it safe. A Romanian company must publish its fiscal
 * code on its own website, so finding that exact number is proof of ownership.
 * Without it, "the domain looks like the name" would happily attribute a
 * squatter's parking page — or a competitor — to your prospect, and a wrong
 * domain is worse than none: it poisons the email guess, the tech stack and
 * every signal derived from them.
 *
 * Free and unmetered. The only cost is time, so it is politely rate limited.
 */
import { createClient } from "@supabase/supabase-js";
import {
  candidateDomains,
  isGuessable,
  pageMentionsCui,
  pageMentionsName,
  verifyDomain,
} from "@/lib/enrichment/domain-guess";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;
const DOH = "https://cloudflare-dns.com/dns-query";

type Options = { limit?: number; dryRun: boolean; county?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
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
async function fetchPage(domain: string): Promise<string | null> {
  for (const url of [`https://${domain}/`, `http://${domain}/`]) {
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

type Company = { id: string; name: string; cui: string };

type Found = {
  id: string;
  name: string;
  domain: string;
  confidence: number;
  reason: string;
};

async function discover(company: Company): Promise<Found | null> {
  const distinctiveName = isGuessable(company.name);
  if (!distinctiveName) return null;

  for (const candidate of candidateDomains(company.name)) {
    if (!(await resolves(candidate.domain))) continue;

    const html = await fetchPage(candidate.domain);
    const verdict = verifyDomain(
      {
        reachable: html !== null,
        cuiOnPage: html ? pageMentionsCui(html, company.cui) : false,
        nameOnPage: html ? pageMentionsName(html, company.name) : false,
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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Companies with no domain yet. Paged: PostgREST caps a select at 1,000.
  const companies: Company[] = [];
  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit
      ? Math.min(PAGE, options.limit - companies.length)
      : PAGE;
    if (wanted <= 0) break;

    let query = db
      .from("companies")
      .select("id, name, cui")
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

  const guessable = companies.filter((company) => isGuessable(company.name));
  console.log(
    `${companies.length} companies without a domain\n` +
      `${guessable.length} have a name distinctive enough to guess from ` +
      `(${companies.length - guessable.length} too generic — skipped)\n`,
  );
  if (guessable.length === 0) return;

  const found = (
    await pooled(guessable, discover, (done) => {
      if (done % 10 === 0 || done === guessable.length) {
        process.stdout.write(`\r  checked ${done}/${guessable.length}`);
      }
    })
  ).filter((result): result is Found => result !== null);

  console.log(
    `\n\nProved ${found.length} domains by CUI — ` +
      `${((found.length / guessable.length) * 100).toFixed(1)}% of those attempted.\n` +
      "Expect this to be low. See docs/STATUS.md: a Romanian company's legal\n" +
      "name is frequently not its brand, and most small firms have no site.\n",
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
