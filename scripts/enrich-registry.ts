/**
 * Enriches imported companies with live ANAF data.
 *
 *   npm run enrich:registry -- --limit 200          # try it on a few first
 *   npm run enrich:registry -- --county Cluj        # a whole slice
 *   npm run enrich:registry -- --refresh            # re-enrich, ignoring cache
 *
 * The ONRC import gives you a company and its *authorised* activities. This
 * adds what ANAF knows, which is a different and more useful set of facts:
 *
 *   - the activity the company actually files under, which frequently differs
 *     from anything it authorised (a company authorised for software may in
 *     fact be an electrical contractor — see docs/STATUS.md)
 *   - VAT registration, VAT-on-collection, e-Factura enrolment
 *   - whether ANAF lists it as an inactive taxpayer — the earliest public
 *     distress signal there is
 *   - revenue, profit and headcount from the annual filing, plus the previous
 *     year so growth can be computed
 *
 * Free, no key, no quota. The only cost is time: ANAF allows ~1 request per
 * second, and a request carries up to 100 CUIs, so the VAT pass runs at roughly
 * 6,000 companies a minute. Financial statements are one request per company
 * per year, which is the slow part — hence `--skip-financials` for a quick
 * first pass.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { AnafClient, type AnafCompany } from "../src/lib/sources/anaf/client";
import { requireEnv } from "./load-env";

const VAT_BATCH = 100;
const WRITE_BATCH = 200;
/**
 * Companies between writes during the financials pass.
 *
 * The pass used to buffer every update and write once at the end. A run over
 * the 5,401 companies with a website takes about three hours, and being
 * interrupted at 4,825 of them wrote **nothing** — three hours of ANAF requests
 * thrown away, with no partial credit and nothing for `--missing-financials` to
 * resume from.
 *
 * 50 companies is roughly two minutes of work at ANAF's rate: small enough that
 * an interruption costs almost nothing, large enough that the writes stay
 * batched rather than one round-trip per company.
 */
const FLUSH_EVERY = 50;

type Options = {
  limit?: number;
  county?: string;
  refresh: boolean;
  skipFinancials: boolean;
  year: number;
  /** Only companies we can also crawl — the ones a web scan will ever see. */
  hasWebsite: boolean;
  /** Only companies still missing a filing pair. Makes a long run resumable. */
  missingFinancials: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    refresh: false,
    skipFinancials: false,
    hasWebsite: false,
    missingFinancials: false,
    // Filings lag by roughly a year; last year is the newest likely to exist.
    year: new Date().getUTCFullYear() - 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--county":
        options.county = next();
        break;
      case "--year":
        options.year = Number(next());
        break;
      case "--refresh":
        options.refresh = true;
        break;
      /*
       * The financials pass is one request per company per year and ANAF
       * serialises at ~1.1s, so the whole register is a day of wall clock.
       * These two flags are what make it a bounded job instead: 5,406 companies
       * with a website are the only ones a web scan will ever look at, and
       * skipping the ones already done means an interrupted run resumes.
       */
      case "--has-website":
        options.hasWebsite = true;
        break;
      case "--missing-financials":
        options.missingFinancials = true;
        options.refresh = true;
        break;
      case "--skip-financials":
        options.skipFinancials = true;
        break;
      default:
        if (argv[i].startsWith("--")) throw new Error(`Unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

type Row = { id: string; cui: string; name: string };

/** What we learned about one company, ready to write back. */
type Update = {
  id: string;
  caen?: string;
  vat_registered?: boolean;
  vat_on_collection?: boolean;
  e_factura_registered?: boolean;
  insolvency_status?: string | null;
  revenue_ron?: number | null;
  revenue_prev_ron?: number | null;
  profit_ron?: number | null;
  employees_anaf?: number | null;
  financials_year?: number | null;
  last_enriched_at: string;
};

function updateFromCompany(id: string, company: AnafCompany): Update {
  return {
    id,
    // ANAF's CAEN is the activity the company files under. It is the more
    // truthful of the two: ONRC lists everything a company is *allowed* to do,
    // which is routinely a dozen activities it has never performed.
    caen: company.caen,
    vat_registered: company.vatRegistered,
    vat_on_collection: company.vatOnCollection,
    e_factura_registered: company.eFacturaRegistered,
    // Null rather than a string when ANAF does not list the company as
    // inactive: absence of a distress record is not a record saying "healthy".
    insolvency_status: company.inactive
      ? `inactiv${company.inactiveSince ? ` din ${company.inactiveSince}` : ""}`
      : null,
    last_enriched_at: new Date().toISOString(),
  };
}

/**
 * Persist and forget the pending updates.
 *
 * Returns how many rows it wrote so the caller can keep a running total, and
 * empties the map — anything still in it after this is work done since.
 */
async function flush(
  supabase: SupabaseClient,
  updates: Map<string, Update>,
): Promise<number> {
  const list = [...updates.values()];
  if (list.length === 0) return 0;
  updates.clear();

  for (let i = 0; i < list.length; i += WRITE_BATCH) {
    const batch = list.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(
      batch.map(({ id, ...fields }) =>
        supabase.from("companies").update(fields).eq("id", id),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) throw new Error(`Write failed: ${failed.error.message}`);
  }
  return list.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const anaf = new AnafClient();

  // --- pick the companies to enrich -----------------------------------------
  /*
   * Paged, because PostgREST caps a select at 1,000 rows and says nothing about
   * it — no error, no truncation flag, just a short array. An unpaged query
   * silently enriched the first tenth of the slice and reported success.
   */
  const PAGE = 1000;
  const rows: Row[] = [];

  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit
      ? Math.min(PAGE, options.limit - rows.length)
      : PAGE;
    if (wanted <= 0) break;

    /*
     * Typed loosely on purpose. Five conditional `.eq`/`.is`/`.not` calls on
     * one builder push PostgREST's generic inference past its depth limit
     * ("Type instantiation is excessively deep"), and the generated `Database`
     * type is still a placeholder here anyway, so the chain buys no real
     * safety. The row shape is asserted on the way out instead.
     */
    let query = supabase
      .from("companies")
      .select("id, cui, name")
      .not("cui", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + wanted - 1) as unknown as {
      eq(column: string, value: unknown): typeof query;
      is(column: string, value: unknown): typeof query;
      not(column: string, operator: string, value: unknown): typeof query;
      then: PromiseLike<{ data: unknown; error: { message: string } | null }>["then"];
    };

    if (options.county) query = query.eq("county", options.county);
    if (options.hasWebsite) query = query.not("domain", "is", null);
    // `revenue_prev_ron` rather than `revenue_ron`: the growth signal needs
    // both years, so a company with only the current one is not done.
    if (options.missingFinancials) query = query.is("revenue_prev_ron", null);
    // Without --refresh, only companies never enriched. Makes the script
    // resumable: interrupt it, run it again, it picks up where it stopped.
    if (!options.refresh) query = query.is("last_enriched_at", null);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < wanted) break;
  }
  if (rows.length === 0) {
    console.log(
      "Nothing to enrich." +
        (options.refresh ? "" : " Everything matching has been enriched; use --refresh to redo it."),
    );
    return;
  }

  const batches = Math.ceil(rows.length / VAT_BATCH);
  console.log(
    `Enriching ${rows.length} companies` +
      (options.county ? ` in ${options.county}` : "") +
      `\n  VAT/status: ${batches} request(s) at ~1/s` +
      (options.skipFinancials
        ? "\n  financials: skipped"
        : `\n  financials: ${rows.length * 2} request(s) — ${options.year} and ${options.year - 1}, both needed for growth — ~${Math.ceil((rows.length * 2 * 1.1) / 60)} min`) +
      "\n",
  );

  const byCui = new Map(rows.map((row) => [row.cui, row]));
  const updates = new Map<string, Update>();
  /** Rows already persisted by an intermediate flush. */
  let flushed = 0;
  let notFound = 0;

  // --- pass 1: VAT, status, real CAEN ---------------------------------------
  for (let i = 0; i < rows.length; i += VAT_BATCH) {
    const batch = rows.slice(i, i + VAT_BATCH);
    let found: AnafCompany[] = [];
    try {
      found = await anaf.lookupByCui(batch.map((row) => row.cui));
    } catch (fetchError) {
      // One bad batch must not lose the run. The queue in AnafClient survives a
      // rejection, so the next batch still goes out.
      console.error(
        `\n  batch at ${i} failed: ${fetchError instanceof Error ? fetchError.message : fetchError}`,
      );
      continue;
    }

    for (const company of found) {
      const row = byCui.get(company.cui);
      if (row) updates.set(row.id, updateFromCompany(row.id, company));
    }
    notFound += batch.length - found.length;
    process.stdout.write(
      `\r  VAT pass: ${Math.min(i + VAT_BATCH, rows.length)}/${rows.length}`,
    );
  }
  console.log(`\n  matched ${updates.size}, not registered for tax ${notFound}\n`);

  // --- pass 2: the annual filing --------------------------------------------
  if (!options.skipFinancials) {
    let withRevenue = 0;
    let done = 0;

    for (const row of rows) {
      done += 1;
      try {
        const current = await anaf.fetchFinancials(row.cui, options.year);
        const previous = await anaf.fetchFinancials(row.cui, options.year - 1);

        if (current || previous) {
          const update =
            updates.get(row.id) ??
            ({ id: row.id, last_enriched_at: new Date().toISOString() } as Update);

          // A company that has not filed is not a company with no revenue, so
          // an absent filing stays null rather than becoming zero.
          update.revenue_ron = current?.revenueRon ?? null;
          update.revenue_prev_ron = previous?.revenueRon ?? null;
          update.profit_ron = current?.profitRon ?? null;
          update.employees_anaf = current?.employees ?? null;
          update.financials_year = current ? options.year : null;
          updates.set(row.id, update);
          if (current?.revenueRon != null) withRevenue += 1;
        }
      } catch {
        // A single unfiled or unreadable year should not stop the run.
      }
      /*
       * Write as we go, and drop what was written.
       *
       * `updates` is a map keyed by company id, so flushing and clearing is
       * safe: the VAT pass's entry for a company is merged into the same object
       * before it ever reaches here, and no later iteration revisits a row.
       */
      if (done % FLUSH_EVERY === 0) {
        flushed += await flush(supabase, updates);
      }
      if (done % 25 === 0 || done === rows.length) {
        process.stdout.write(
          `\r  financials: ${done}/${rows.length} (${flushed} written)`,
        );
      }
    }
    console.log(`\n  ${withRevenue} companies with a ${options.year} revenue figure\n`);
  }

  // --- write whatever the last flush did not take ---------------------------
  const list = [...updates.values()];
  if (list.length === 0) {
    console.log(
      flushed === 0
        ? "Nothing matched at ANAF — nothing written."
        : `\n✓ Enriched ${flushed} companies`,
    );
    return;
  }

  let written = 0;
  for (let i = 0; i < list.length; i += WRITE_BATCH) {
    const batch = list.slice(i, i + WRITE_BATCH);
    // One statement per row: these are updates to existing companies, and an
    // upsert keyed on id would need every not-null column restated.
    const results = await Promise.all(
      batch.map(({ id, ...fields }) =>
        supabase.from("companies").update(fields).eq("id", id),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error(`\nWrite failed: ${failed.error.message}`);
      console.error(`Wrote ${flushed + written} before failing. Re-running resumes safely.`);
      process.exit(1);
    }
    written += batch.length;
    process.stdout.write(`\r  writing: ${written}/${list.length}`);
  }

  // `flushed` plus the tail. Reporting only the tail made a run that wrote
  // 5,401 rows announce that it had enriched 51 of them.
  console.log(`\n✓ Enriched ${flushed + written} companies`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
