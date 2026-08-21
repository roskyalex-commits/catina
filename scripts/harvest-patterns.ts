/**
 * Learns each company's email convention from the addresses it publishes.
 *
 *   npm run harvest:patterns -- --dry-run --limit 50
 *   npm run harvest:patterns -- --limit 200
 *   npm run harvest:patterns              # every domain with a person
 *
 * ## What this unblocks
 *
 * `EmailWaterfall` has always had a pattern-inference step and it has never
 * fired once, because `knownContacts` was never supplied by any caller. Every
 * one of the 1,566 addresses in the table is a role address — `office@`,
 * `contact@` — so there has never been a confirmed name/address pair to infer
 * a convention from. This produces them.
 *
 * The mechanism is worth stating because it is the whole reason a data vendor
 * is optional here. ONRC tells us, by law, who administers a company. If that
 * company publishes `andrei.pop@firma.ro` anywhere on its site, and we hold a
 * person called Pop Andrei there, the pairing confirms both the address *and*
 * that the company writes addresses `first.last`. Every other administrator at
 * that domain then has a derivable address — from a legal filing and a public
 * web page, with no LinkedIn and no enrichment credits.
 *
 * ## What it stores, and why that is a decision
 *
 * Personal addresses are persisted, not only the convention derived from them.
 * That is a deliberate reversal of the `roleOnly` posture the bulk crawler
 * takes, taken by the user as data controller so that outreach has a confirmed
 * address to send to rather than a generated one. It comes with `source_url` on
 * every row: an address we cannot point back to the page that published it is
 * one we should not be holding.
 */
import { createClient } from "@supabase/supabase-js";
import { fetchContactAddresses } from "../src/lib/crawl/fetch-site";
import { saveHarvestedEmail } from "../src/lib/enrichment/enrich-lead";
import { MxChecker } from "../src/lib/enrichment/mx";
import {
  bestCompanyPattern,
  pairAddresses,
  type KnownPerson,
} from "../src/lib/enrichment/pattern-discovery";
import { requireEnv } from "./load-env";

const PAGE = 1000;
/** Matches `enrich-emails.ts`, for the same per-host politeness reason. */
const CONCURRENCY = 8;

type Options = {
  dryRun: boolean;
  force: boolean;
  limit: number;
  concurrency: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    force: false,
    limit: Infinity,
    concurrency: CONCURRENCY,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--concurrency":
        options.concurrency = Number(next());
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

const mx = new MxChecker();

type Target = { id: string; domain: string; name: string; people: KnownPerson[] };

/**
 * Companies worth crawling: a domain to read, and at least one resolved person
 * to pair an address against.
 *
 * The second condition is what makes this cheap. A company with no people
 * cannot produce a confirmed pair however many addresses it publishes, so
 * crawling it buys a role address we already harvest elsewhere.
 */
async function loadTargets(limit: number): Promise<Target[]> {
  const companies = new Map<string, Target>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("companies")
      .select("id, name, domain")
      .not("domain", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`companies: ${error.message}`);
    if (!data?.length) break;

    for (const row of data) {
      companies.set(row.id as string, {
        id: row.id as string,
        name: row.name as string,
        domain: row.domain as string,
        people: [],
      });
    }
    if (data.length < PAGE) break;
  }

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("people")
      .select("id, company_id, full_name, first_name, last_name")
      .not("first_name", "is", null)
      .not("last_name", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`people: ${error.message}`);
    if (!data?.length) break;

    for (const row of data) {
      const company = companies.get(row.company_id as string);
      if (!company) continue;
      company.people.push({
        id: row.id as string,
        fullName: row.full_name as string,
        firstName: row.first_name as string,
        lastName: row.last_name as string,
      });
    }
    if (data.length < PAGE) break;
  }

  return [...companies.values()]
    .filter((company) => company.people.length > 0)
    .slice(0, Number.isFinite(limit) ? limit : undefined);
}

/**
 * Company ids the harvester has already looked at — found or not.
 *
 * Keyed on `email_pattern_checked_at`, not on `email_pattern`. Skipping only
 * the domains where a pattern was *found* means a resumed run re-crawls every
 * domain that already answered "nothing here", which is ~97% of them: measured
 * at 518 re-crawls producing zero new patterns before this was fixed. The
 * absence of a pattern is a result, and it has to be recorded as one.
 */
async function alreadyChecked(): Promise<Set<string>> {
  const done = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("company_scans")
      .select("company_id")
      .not("email_pattern_checked_at", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`company_scans: ${error.message}`);
    if (!data?.length) break;
    for (const row of data) done.add(row.company_id as string);
    if (data.length < PAGE) break;
  }
  return done;
}

type Outcome = {
  domain: string;
  addresses: number;
  personal: number;
  pairs: number;
  /** Zero means we learned nothing and this domain must be retried. */
  pagesRead: number;
  pattern?: string;
  confidence?: number;
  basis?: "paired" | "shape";
};

async function harvest(target: Target): Promise<Outcome> {
  const { addresses: harvested, pagesRead } = await fetchContactAddresses(
    target.domain,
  ).catch(() => ({ addresses: [], pagesRead: 0 }));

  const outcome: Outcome = {
    domain: target.domain,
    addresses: harvested.length,
    personal: harvested.filter((entry) => !entry.isRole).length,
    pairs: 0,
    pagesRead,
  };
  /*
   * No early return for an unreachable site.
   *
   * Returning here would skip the `email_pattern_checked_at` stamp below, so
   * every dead or JavaScript-only domain would be re-crawled on every resume,
   * forever — and at 63% unreachable that is most of the work. "We looked and
   * there was nothing" is a result worth recording, which is the same reason
   * `company_scans` exists at all.
   */
  const pairs = pairAddresses(
    harvested.map((entry) => entry.address),
    target.people,
  );
  outcome.pairs = pairs.length;

  const inferred = bestCompanyPattern(
    pairs,
    harvested.map((entry) => entry.address),
  );
  if (inferred) {
    outcome.pattern = inferred.pattern;
    outcome.confidence = inferred.confidence;
    outcome.basis = inferred.basis;
  }

  /*
   * The MX lookup is free, cached, and answers a question the verifier would
   * otherwise be spent on: a domain that takes no mail makes every address at
   * it dead, and one on Google Workspace behaves differently at verification
   * time from a shared cPanel host.
   */
  const mxResult = await mx.check(target.domain);

  await db.from("company_scans").upsert(
    {
      company_id: target.id,
      email_pattern: inferred?.pattern ?? null,
      email_pattern_confidence: inferred?.confidence ?? null,
      // The real basis, not a lump label: a pair confirms an identity, a
      // shape only reads like one, and the measurement has to tell them apart.
      email_pattern_source: inferred?.basis ?? null,
      email_pattern_samples: inferred?.samples ?? 0,
      // Stamped whether or not a pattern was found — this is what makes a
      // resumed run skip the domains that already answered "nothing here".
      /*
       * Stamped only when a page was actually read.
       *
       * "We read the site and it publishes no address" is a settled answer and
       * should never be re-crawled. "We could not read the site" is not an
       * answer at all, and stamping it buries the domain permanently — which is
       * exactly what a degraded run did to 3,333 of them.
       */
      email_pattern_checked_at: pagesRead > 0 ? new Date().toISOString() : null,
      mx_provider: mxResult.provider ?? null,
      scanned_at: new Date().toISOString(),
    },
    { onConflict: "company_id" },
  );

  const byAddress = new Map(pairs.map((pair) => [pair.address, pair]));

  for (const entry of harvested) {
    const pair = byAddress.get(entry.address);
    const saved = await saveHarvestedEmail(
      db,
      { personId: pair?.personId || null, companyId: target.id },
      {
        address: entry.address,
        // `found`, never `verified`: the company published it, which proves it
        // is a stated contact route, not that the mailbox accepts mail.
        status: "found",
        confidence: pair ? 0.8 : entry.isRole ? 0.55 : 0.5,
        provider: "crawler",
        isRoleAddress: entry.isRole,
        mxValid: mxResult.acceptsMail,
      },
      entry.sourceUrl,
    );
    if (saved.error) throw new Error(`${entry.address}: ${saved.error}`);
  }

  return outcome;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const targets = await loadTargets(options.limit);
  const done = options.force ? new Set<string>() : await alreadyChecked();
  const todo = targets.filter((target) => !done.has(target.id));

  console.log(
    `${targets.length} companies with a domain and a resolved person\n` +
      `${targets.length - todo.length} already looked at, ` +
      `${todo.length} to crawl\n`,
  );

  if (options.dryRun || todo.length === 0) {
    if (options.dryRun) {
      console.log("Dry run — nothing was crawled and nothing was written.");
      for (const target of todo.slice(0, 10)) {
        console.log(`  ${target.domain.padEnd(32)} ${target.people.length} people`);
      }
    }
    return;
  }

  const outcomes: Outcome[] = [];
  let next = 0;
  let crawled = 0;

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, todo.length) }, async () => {
      while (next < todo.length) {
        const target = todo[next++];
        try {
          outcomes.push(await harvest(target));
        } catch (error) {
          console.error(
            `\n  ${target.domain}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        crawled += 1;
        if (crawled % 20 === 0 || crawled === todo.length) {
          const hits = outcomes.filter((outcome) => outcome.pattern).length;
          process.stdout.write(
            `\r  crawled ${crawled}/${todo.length}, ${hits} patterns inferred`,
          );
        }
      }
    }),
  );

  report(outcomes);
}

function report(outcomes: Outcome[]) {
  const read = outcomes.filter((outcome) => outcome.pagesRead > 0);
  const reachable = outcomes.filter((outcome) => outcome.addresses > 0);
  const withPersonal = outcomes.filter((outcome) => outcome.personal > 0);
  const withPattern = outcomes.filter((outcome) => outcome.pattern);
  const paired = withPattern.filter((outcome) => outcome.basis === "paired");

  console.log(`\n\nCrawled ${outcomes.length} sites\n`);
  console.log(`  site could be read         ${pct(read.length, outcomes.length)}`);
  console.log(`  published any address      ${pct(reachable.length, outcomes.length)}`);
  console.log(`  published a personal one   ${pct(withPersonal.length, outcomes.length)}`);
  console.log(`  pattern known              ${pct(withPattern.length, outcomes.length)}`);
  console.log(`    of which confirmed       ${pct(paired.length, outcomes.length)}`);
  console.log(`    of which read off shape  ${pct(withPattern.length - paired.length, outcomes.length)}`);

  const byPattern = new Map<string, number>();
  for (const outcome of withPattern) {
    byPattern.set(outcome.pattern!, (byPattern.get(outcome.pattern!) ?? 0) + 1);
  }

  if (byPattern.size > 0) {
    console.log(`\n  conventions found:`);
    for (const [pattern, count] of [...byPattern].sort((a, b) => b[1] - a[1])) {
      console.log(
        `    ${pattern.padEnd(12)} ${String(count).padStart(4)}  ` +
          `${pct(count, withPattern.length)}`,
      );
    }
  }

  /*
   * The number the plan turns on. If confirmation is rare, the product cannot
   * rely on per-company inference and has to lean on the measured prior
   * instead — which is a different design, and better learned here than after
   * building on the assumption.
   */
  console.log(
    `\n  ${withPattern.length} of ${outcomes.length} domains can now have every ` +
      `administrator's address derived.`,
  );
}

function pct(part: number, total: number): string {
  if (total === 0) return "0 (0.0%)";
  return `${String(part).padStart(4)} (${((part / total) * 100).toFixed(1)}%)`;
}

main();
