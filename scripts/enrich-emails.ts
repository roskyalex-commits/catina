/**
 * Finds email addresses for leads that have none.
 *
 *   npm run enrich:emails -- --limit 20 --dry-run
 *   npm run enrich:emails -- --limit 200
 *   npm run enrich:emails -- --force        # re-try leads a previous run missed
 *
 * This is the bulk twin of POST /api/v1/leads/[id]/enrich. Same orchestration,
 * same persistence; only the loop and the reporting are different.
 *
 * Two things worth knowing before running it.
 *
 * **Yield is bounded by domains, not by this script.** The free route to an
 * address is crawling the prospect's own site for its published `office@`, and
 * that needs a domain. Roughly 1% of registry companies carry one, so the
 * honest denominator is *leads with a domain*, not *leads*. The report below
 * prints both, because dividing by the wrong one turns a working pipeline into
 * an apparent 1% success rate.
 *
 * **Misses are recorded.** `leads.enriched_at` is stamped whether or not an
 * address was found, so a second run does not re-spend on the same empty
 * answers. Pass `--force` when you have a reason to believe the answer changed
 * — a new provider key, or a domain that has since been discovered.
 */
import { createClient } from "@supabase/supabase-js";
import { fetchRoleEmails } from "../src/lib/crawl/fetch-site";
import {
  buildWaterfall,
  enrichLead,
  enrichableLeadFrom,
  knownRoleEmailsFor,
  saveCompanyRoleEmail,
  saveEnrichment,
  ENRICHABLE_LEAD_COLUMNS,
  type EnrichableLead,
} from "../src/lib/enrichment/enrich-lead";
import { requireEnv } from "./load-env";

const PAGE = 1000;
/** Between requests to the *same* host, when a lead is resolved on its own. */
const PAUSE_MS = 400;
/**
 * Companies crawled at once during the bulk harvest.
 *
 * Politeness is a per-host property, and these are all different hosts — each
 * one is visited at most twice, whether we walk them one at a time or eight at
 * a time. Sequentially, 5,400 companies is several hours; this makes it
 * minutes, and no individual site notices the difference.
 */
const HARVEST_CONCURRENCY = 8;

type Options = {
  limit?: number;
  orgId?: string;
  force: boolean;
  dryRun: boolean;
  /** Harvest role addresses per company instead of resolving per lead. */
  companies: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { force: false, dryRun: false, companies: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--org":
        options.orgId = next();
        break;
      case "--force":
        options.force = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--companies":
        options.companies = true;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Leads still without an address.
 *
 * Paged with `.range()`: PostgREST caps a select at 1,000 rows and says nothing
 * about it, which is how an earlier full-registry pass reported success having
 * touched a tenth of the data.
 */
async function loadLeads(options: Options, orgId: string): Promise<EnrichableLead[]> {
  const leads: EnrichableLead[] = [];

  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit ? Math.min(PAGE, options.limit - leads.length) : PAGE;
    if (wanted <= 0) break;

    let query = db
      .from("leads")
      .select(ENRICHABLE_LEAD_COLUMNS)
      .eq("org_id", orgId)
      .is("email_id", null)
      // Best leads first: if a budget runs out mid-run, it should run out on
      // the leads that mattered least.
      .order("score", { ascending: false })
      .range(from, from + wanted - 1);

    if (!options.force) query = query.is("enriched_at", null);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read leads: ${error.message}`);
      process.exit(1);
    }

    const page = (data ?? []).map((row) =>
      enrichableLeadFrom(row as Record<string, unknown>),
    );
    leads.push(...page);
    if (page.length < wanted) break;
  }

  return leads;
}

async function resolveOrgId(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  const { data, error } = await db
    .from("orgs")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(2);

  if (error) {
    console.error(`Could not read orgs: ${error.message}`);
    process.exit(1);
  }
  const orgs = (data ?? []) as { id: string; name: string }[];
  if (orgs.length === 0) {
    console.error("No workspaces exist yet. Sign up in the app first.");
    process.exit(1);
  }
  if (orgs.length > 1) {
    console.error(
      "More than one workspace exists — pass --org <id> so the credit ledger " +
        "is charged to the right one.",
    );
    process.exit(1);
  }
  return orgs[0].id;
}

/**
 * Harvest role addresses for every company that has a domain.
 *
 * Independent of leads on purpose. `emails` is shared reference data, so an
 * address found here serves every workspace and every future lead at that
 * company — and the crawl is the same page fetch either way. Running this
 * before a sourcing run means the leads it produces arrive contactable rather
 * than needing a second pass.
 *
 * Measured on the current slice: 37 of 140 companies with a domain publish one
 * (26%). That is the real ceiling of the free path, and it is why step 5b —
 * finding domains at all — is the thing that matters next.
 */
async function harvestCompanies(options: Options) {
  const companies: { id: string; name: string; domain: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit ? Math.min(PAGE, options.limit - companies.length) : PAGE;
    if (wanted <= 0) break;

    const { data, error } = await db
      .from("companies")
      .select("id, name, domain")
      .not("domain", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + wanted - 1);

    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as { id: string; name: string; domain: string }[];
    companies.push(...page);
    if (page.length < wanted) break;
  }

  // Already harvested: the page has not changed, and re-fetching it is the
  // only cost this whole pass has.
  const known = options.force
    ? new Map<string, string[]>()
    : await knownRoleEmailsFor(db, companies.map((company) => company.id));
  const todo = companies.filter((company) => !known.has(company.id));

  console.log(
    `${companies.length} companies with a domain, ` +
      `${companies.length - todo.length} already harvested, ${todo.length} to crawl\n`,
  );
  if (options.dryRun || todo.length === 0) {
    if (options.dryRun) console.log("Dry run — nothing was crawled and nothing was written.");
    return;
  }

  let found = 0;
  let done = 0;
  let next = 0;

  await Promise.all(
    Array.from({ length: Math.min(HARVEST_CONCURRENCY, todo.length) }, async () => {
      while (next < todo.length) {
        const company = todo[next++];
        const addresses = await fetchRoleEmails(company.domain).catch(() => []);
        for (const address of addresses) {
          const saved = await saveCompanyRoleEmail(db, company.id, address);
          if (saved.error) console.error(`\n  ${company.domain}: ${saved.error}`);
          else found += 1;
        }
        done += 1;
        if (done % 25 === 0 || done === todo.length) {
          process.stdout.write(`\r  crawled ${done}/${todo.length}, ${found} addresses`);
        }
      }
    }),
  );

  console.log(
    `\n\nWrote ${found} role addresses from ${todo.length} sites ` +
      `(${((found / todo.length) * 100).toFixed(1)}%).\n`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.companies) return harvestCompanies(options);

  const orgId = await resolveOrgId(options.orgId);
  const leads = await loadLeads(options, orgId);

  const withDomain = leads.filter((lead) => lead.domain);
  console.log(
    `${leads.length} leads without an email address\n` +
      `${withDomain.length} of them have a company domain to work from ` +
      `(${leads.length - withDomain.length} do not — nothing free can be tried ` +
      `for those; see step 5b in docs/STATUS.md)\n`,
  );
  if (withDomain.length === 0) return;

  if (options.dryRun) {
    for (const lead of withDomain.slice(0, 20)) {
      console.log(`  ${(lead.domain ?? "").padEnd(30)} ${lead.companyName}`);
    }
    console.log("\nDry run — nothing was crawled and nothing was written.");
    return;
  }

  // Whatever the company harvest already found, so a second pass over the same
  // company does not re-fetch the same page.
  const known = await knownRoleEmailsFor(
    db,
    withDomain.map((lead) => lead.companyId).filter((id): id is string => id !== null),
  );

  const waterfall = buildWaterfall(db, orgId);
  let found = 0;
  let written = 0;
  let scoreGain = 0;
  const examples: string[] = [];

  for (const [index, lead] of withDomain.entries()) {
    const outcome = await enrichLead(
      { waterfall, roleEmails: fetchRoleEmails },
      { ...lead, knownRoleEmails: known.get(lead.companyId ?? "") },
      { force: options.force },
    );

    if (outcome.email) {
      found += 1;
      scoreGain += outcome.scoreAfter - outcome.scoreBefore;
      if (examples.length < 15) {
        examples.push(
          `  ${outcome.email.address.padEnd(34)} ${outcome.email.status.padEnd(9)} ` +
            `${outcome.scoreBefore} → ${outcome.scoreAfter}  ${lead.companyName.slice(0, 30)}`,
        );
      }
    }

    // Both clients are the service-role one here: a script has no session, and
    // there is no user whose RLS could scope the lead update.
    const saved = await saveEnrichment({ admin: db, scoped: db }, lead, outcome);
    if (saved.error) {
      console.error(`\n  ${lead.companyName}: ${saved.error}`);
    } else if (!outcome.skipped) {
      written += 1;
    }

    process.stdout.write(`\r  checked ${index + 1}/${withDomain.length}, ${found} found`);
    await sleep(PAUSE_MS);
  }

  console.log(
    `\n\nFound ${found} addresses from ${withDomain.length} leads with a domain ` +
      `(${((found / withDomain.length) * 100).toFixed(1)}%).\n` +
      `${written} leads updated. Average score movement on a hit: ` +
      `+${found ? (scoreGain / found).toFixed(1) : "0"} points.\n`,
  );
  for (const example of examples) console.log(example);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
