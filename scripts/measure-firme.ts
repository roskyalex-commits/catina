/**
 * Is FirmeAPI worth subscribing to? Answered on the free credits, before paying.
 *
 *   npm run measure:firme                    # 150 domainless + 30 control
 *   npm run measure:firme -- --limit 40      # smaller, cheaper
 *
 * FirmeAPI gives 1,000 credits on signup with no card. A contact lookup costs
 * 5, so the free allowance buys **200 companies** — comfortably enough to
 * settle this.
 *
 * ## The question this answers, and the one it refuses to answer
 *
 * The vendor quotes 40% website coverage over ~3M Romanian companies. That
 * number cannot be applied to us, because a company that publishes a website is
 * exactly the sort whose website ONRC already lists — and we already hold
 * 31.5%. What decides the subscription is the *marginal* yield: of the
 * companies we have **no** domain for, how many does the vendor give a real
 * company domain for?
 *
 * This project has already made that mistake once, with Brave: 8.3% measured on
 * companies that already had a domain, **0.1%** on the ones that needed one, and
 * the first number was quoted as if it were the second for a whole commit.
 *
 * So this reports two populations and never averages them:
 *
 *   - **domainless** — the companies a bulk run would target. This is the
 *     number that decides.
 *   - **control** — companies whose domain we already know, where the right
 *     answer is available, so vendor accuracy can be checked rather than
 *     assumed.
 *
 * ## Corporate domain, not just "an email"
 *
 * A Romanian SMB publishing `firma@yahoo.ro` is reachable but gives us nothing
 * to crawl, and crawling is where the signal half of the score comes from — no
 * lead without a domain has ever scored above 52. So an address on a consumer
 * mailbox counts separately from one that implies a company domain, and the
 * headline figure is **companies that gain a crawlable domain**, from either
 * the `website` field or a corporate email address.
 */
import { createClient } from "@supabase/supabase-js";
import { isFreeMailDomain } from "../src/lib/enrichment/mx";
import {
  CONTACT_CREDIT_COST,
  FirmeApiClient,
  FirmeApiError,
  toDomain,
} from "../src/lib/sources/firme/client";
import { requireEnv } from "./load-env";

const PAGE = 1000;
/** 150 + 30 = 180 calls = 900 credits, inside the 1,000 free ones. */
const DEFAULT_TARGET = 150;
const DEFAULT_CONTROL = 30;

type Options = { limit: number; control: number };

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: DEFAULT_TARGET, control: DEFAULT_CONTROL };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--control":
        options.control = Number(next());
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

const firme = new FirmeApiClient(process.env.FIRMEAPI_KEY);

type Company = { id: string; cui: string; name: string; domain: string | null };

/** What the loosened query above resolves to; narrowed by hand below. */
type QueryResult = {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
};

async function load(withDomain: boolean, limit: number): Promise<Company[]> {
  const rows: Company[] = [];
  for (let from = 0; rows.length < limit; from += PAGE) {
    /*
     * Loosely typed on purpose. Chaining a conditional filter onto a PostgREST
     * builder makes supabase-js instantiate its generic return type once per
     * link, and TypeScript gives up with "Type instantiation is excessively
     * deep" — the same wall `enrich-registry.ts` hit. The rows are narrowed by
     * hand below either way, which is what `src/lib/supabase/row.ts` exists for.
     */
    const base = db
      .from("companies")
      .select("id, cui, name, domain")
      .not("cui", "is", null)
      .order("id")
      .range(from, from + PAGE - 1) as unknown as {
      not: (a: string, b: string, c: null) => Promise<QueryResult>;
      is: (a: string, b: null) => Promise<QueryResult>;
    };

    const { data, error } = await (withDomain
      ? base.not("domain", "is", null)
      : base.is("domain", null));
    if (error) throw new Error(`companies: ${error.message}`);
    if (!data?.length) break;

    for (const row of data) {
      if (rows.length >= limit) break;
      rows.push({
        id: row.id as string,
        cui: String(row.cui),
        name: row.name as string,
        domain: (row.domain as string | null) ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return rows;
}

type Tally = {
  asked: number;
  found: number;
  withWebsite: number;
  withAnyEmail: number;
  withCorporateEmail: number;
  freeMailOnly: number;
  /** The headline: gains a crawlable domain from website OR a corporate email. */
  gainsDomain: number;
  withNamedContact: number;
  withRole: number;
  roles: Map<string, number>;
  /** Control only: vendor's domain agreed with the one we hold. */
  agreed: number;
  disagreed: number;
};

function emptyTally(): Tally {
  return {
    asked: 0,
    found: 0,
    withWebsite: 0,
    withAnyEmail: 0,
    withCorporateEmail: 0,
    freeMailOnly: 0,
    gainsDomain: 0,
    withNamedContact: 0,
    withRole: 0,
    roles: new Map(),
    agreed: 0,
    disagreed: 0,
  };
}

async function measure(
  label: string,
  companies: Company[],
  tally: Tally,
  samples: string[],
): Promise<void> {
  for (const [index, company] of companies.entries()) {
    tally.asked += 1;
    let contact;
    try {
      contact = await firme.fetchContact(company.cui);
    } catch (error) {
      if (error instanceof FirmeApiError && (error.status === 402 || error.status === 429)) {
        console.error(`\n  stopping: ${error.message}`);
        return;
      }
      continue;
    }
    process.stdout.write(`\r  ${label}: ${index + 1}/${companies.length}`);
    if (!contact) continue;
    tally.found += 1;

    const siteDomains = contact.websites
      .map(toDomain)
      .filter((d): d is string => d !== null)
      // A vendor returning a consumer host as a "website" is returning noise.
      .filter((d) => !isFreeMailDomain(`x@${d}`));

    const corporateEmails = contact.emails.filter((e) => !isFreeMailDomain(e));
    const emailDomains = corporateEmails
      .map((e) => e.split("@").pop() ?? "")
      .map((d) => toDomain(d))
      .filter((d): d is string => d !== null);

    if (siteDomains.length) tally.withWebsite += 1;
    if (contact.emails.length) tally.withAnyEmail += 1;
    if (corporateEmails.length) tally.withCorporateEmail += 1;
    if (contact.emails.length > 0 && corporateEmails.length === 0) tally.freeMailOnly += 1;

    const gained = [...new Set([...siteDomains, ...emailDomains])];
    if (gained.length) tally.gainsDomain += 1;

    if (contact.people.length) tally.withNamedContact += 1;
    for (const person of contact.people) {
      if (!person.role) continue;
      tally.withRole += 1;
      const role = person.role.toLowerCase();
      tally.roles.set(role, (tally.roles.get(role) ?? 0) + 1);
    }

    if (company.domain) {
      const known = toDomain(company.domain);
      if (known && gained.length) {
        if (gained.includes(known)) tally.agreed += 1;
        else tally.disagreed += 1;
      }
    } else if (gained.length && samples.length < 12) {
      samples.push(
        `  ${company.name.slice(0, 34).padEnd(36)} ${gained[0]}` +
          (contact.people[0]?.role ? `  (${contact.people[0].role})` : ""),
      );
    }
  }
}

function pct(part: number, total: number): string {
  if (total === 0) return "   0 (  0.0%)";
  return `${String(part).padStart(4)} (${((part / total) * 100).toFixed(1).padStart(5)}%)`;
}

function report(label: string, tally: Tally) {
  console.log(`\n${label} — ${tally.asked} companies asked, ${tally.found} known to the vendor\n`);
  console.log(`  website field            ${pct(tally.withWebsite, tally.asked)}`);
  console.log(`  any email                ${pct(tally.withAnyEmail, tally.asked)}`);
  console.log(`  corporate email          ${pct(tally.withCorporateEmail, tally.asked)}`);
  console.log(`  consumer mailbox only    ${pct(tally.freeMailOnly, tally.asked)}`);
  console.log(`  named contact person     ${pct(tally.withNamedContact, tally.asked)}`);
  console.log(`  ---`);
  console.log(`  GAINS A CRAWLABLE DOMAIN ${pct(tally.gainsDomain, tally.asked)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!firme.isConfigured()) {
    console.error(
      "FIRMEAPI_KEY is not set.\n\n" +
        "  Create a free account at https://www.firmeapi.ro/ — no card, 1,000 credits.\n" +
        `  A contact lookup costs ${CONTACT_CREDIT_COST}, so that is 200 companies, and this\n` +
        "  measurement uses at most 180 of them.",
    );
    process.exit(1);
  }

  const targets = await load(false, options.limit);
  const control = await load(true, options.control);

  console.log(
    `Measuring FirmeAPI on two populations, ${CONTACT_CREDIT_COST} credits per company.\n` +
      `  ${targets.length} with no domain — the population a bulk run would target\n` +
      `  ${control.length} with a known domain — to check the vendor agrees with us\n` +
      `  budget: ${(targets.length + control.length) * CONTACT_CREDIT_COST} credits\n`,
  );

  const domainless = emptyTally();
  const known = emptyTally();
  const samples: string[] = [];

  await measure("domainless", targets, domainless, samples);
  await measure("control", control, known, samples);

  report("DOMAINLESS — this is the number that decides", domainless);
  report("CONTROL — companies whose domain we already hold", known);

  if (known.agreed + known.disagreed > 0) {
    console.log(
      `\n  vendor agreed with the domain we hold: ` +
        `${pct(known.agreed, known.agreed + known.disagreed)}`,
    );
  }

  if (domainless.roles.size > 0) {
    console.log(`\nContact roles returned (the job-title question):`);
    for (const [role, count] of [...domainless.roles].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${role.slice(0, 40).padEnd(42)} ${count}`);
    }
  } else {
    console.log(`\nNo contact roles returned at all — this buys reach, not job titles.`);
  }

  if (samples.length) {
    console.log(`\nDomains it would add:`);
    for (const sample of samples) console.log(sample);
  }

  console.log(`\ncredits spent: ${firme.spent()} of the 1,000 free\n`);

  /*
   * The verdict, stated in money rather than percentages.
   *
   * 11,750 companies have no domain. The subscription is worth it if the
   * domains it would add are worth more than it costs — and a domain is worth
   * having because no lead without one has ever scored above 52.
   */
  const rate = domainless.asked ? domainless.gainsDomain / domainless.asked : 0;
  const wouldGain = Math.round(rate * 11_750);
  console.log(
    `At ${(rate * 100).toFixed(1)}% on the domainless population, a full pass would add\n` +
      `roughly ${wouldGain.toLocaleString("en-US")} domains, taking coverage from 31.5% to ` +
      `${(((5406 + wouldGain) / 17156) * 100).toFixed(1)}%.\n` +
      `It would cost ${((11_750 * CONTACT_CREDIT_COST) / 1000).toFixed(0)}k credits.`,
  );

  if (rate < 0.15) {
    console.log(
      `\n  Below 15% this is not worth a subscription. The vendor's headline 40%\n` +
        `  is measured over every Romanian company, and the ones with websites are\n` +
        `  the ones we already found.`,
    );
  }
}

main();
