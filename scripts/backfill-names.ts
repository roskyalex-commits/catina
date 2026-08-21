/**
 * Splits `people.full_name` into `first_name` and `last_name`.
 *
 *   npm run backfill:names -- --dry-run
 *   npm run backfill:names
 *   npm run backfill:names -- --force        # redo rows already split
 *
 * Both columns have existed since the first migration and all 29,551 rows have
 * them null, because `import-representatives.ts` only ever wrote `full_name` —
 * ONRC ships one `NUME` column and the importer had nothing to split it with.
 *
 * Doing it here, once, rather than inside the email generator, for three
 * reasons. The result is inspectable: a wrong split is visible in the table
 * instead of only in an address nobody reads until it bounces. It is stable:
 * regenerating the lexicon cannot silently change an address that has already
 * been sent to. And it is cheap: ~30,000 resolutions once, not once per
 * enrichment run.
 *
 * Rows below `MIN_NAME_CONFIDENCE` are left null on purpose. Null means "we do
 * not know", which the enrichment path reads as "do not build an address for
 * this person" — the intended outcome. Filling them in with a coin flip would
 * turn a skipped contact into a wrong one.
 */
import { createClient } from "@supabase/supabase-js";
import {
  MIN_NAME_CONFIDENCE,
  resolvePersonName,
  type ResolvedName,
} from "../src/lib/enrichment/romanian-names";
import { requireEnv } from "./load-env";

const PAGE = 1000;
/**
 * Write every 200 rows rather than at the end.
 *
 * The ANAF financials pass buffered 5,401 updates and was interrupted at 4,825
 * with nothing written — three hours lost to a run that had done all the work.
 * Same shape of job, same fix.
 */
const FLUSH_EVERY = 200;

type Options = { dryRun: boolean; force: boolean; limit: number };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false, force: false, limit: Infinity };
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

type PersonRow = {
  id: string;
  company_id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  source: string;
};

/**
 * The columns an upsert has to carry.
 *
 * `people` declares `company_id`, `full_name` and `source` NOT NULL. PostgREST's
 * upsert is `INSERT ... ON CONFLICT DO UPDATE`, so the insert arm is type-checked
 * against the table even though the conflict always fires for a row that exists.
 * Omitting them fails the whole batch rather than the row.
 */
type Update = {
  id: string;
  company_id: string;
  full_name: string;
  source: string;
  first_name: string;
  last_name: string;
};

async function flush(updates: Update[]): Promise<number> {
  if (updates.length === 0) return 0;
  /*
   * Batched, not one statement per row.
   *
   * 29,551 individual updates is 29,551 round trips — about a quarter of an
   * hour of latency for two columns. The conflict target is the primary key, so
   * only `first_name` and `last_name` actually change; `linkedin_url` and the
   * rest are absent from the payload and the update arm leaves them alone.
   */
  const { error } = await db.from("people").upsert(updates, { onConflict: "id" });
  if (error) throw new Error(`people upsert: ${error.message}`);
  return updates.length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const stats = {
    read: 0,
    written: 0,
    skippedLowConfidence: 0,
    alreadySplit: 0,
  };
  const byBasis: Record<ResolvedName["basis"], number> = {
    lexicon: 0,
    convention: 0,
    unresolved: 0,
  };
  const byOrder: Record<string, number> = {};
  const samples: string[] = [];

  let pending: Update[] = [];

  for (let from = 0; stats.read < options.limit; from += PAGE) {
    const { data, error } = await db
      .from("people")
      .select("id, company_id, full_name, first_name, last_name, source")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`people: ${error.message}`);
    if (!data?.length) break;

    for (const row of data as PersonRow[]) {
      if (stats.read >= options.limit) break;
      stats.read += 1;

      if (!options.force && row.first_name && row.last_name) {
        stats.alreadySplit += 1;
        continue;
      }

      // Resolve from `full_name` even when the columns are set, under --force:
      // the point of --force is to redo them after a lexicon change.
      const resolved = resolvePersonName({
        fullName: row.full_name,
        source: row.source,
      });

      byBasis[resolved.basis] += 1;
      byOrder[resolved.order] = (byOrder[resolved.order] ?? 0) + 1;

      if (
        resolved.confidence < MIN_NAME_CONFIDENCE ||
        !resolved.firstName ||
        !resolved.lastName
      ) {
        stats.skippedLowConfidence += 1;
        continue;
      }

      if (samples.length < 15) {
        samples.push(
          `  ${row.full_name.padEnd(30)} -> ${resolved.firstName}.${resolved.lastName}` +
            `  (${resolved.basis}, ${resolved.confidence.toFixed(2)})`,
        );
      }

      pending.push({
        id: row.id,
        company_id: row.company_id,
        full_name: row.full_name,
        source: row.source,
        first_name: resolved.firstName,
        last_name: resolved.lastName,
      });

      if (!options.dryRun && pending.length >= FLUSH_EVERY) {
        stats.written += await flush(pending);
        pending = [];
      }
    }

    if (data.length < PAGE) break;
  }

  if (!options.dryRun) {
    stats.written += await flush(pending);
  } else {
    stats.written = pending.length;
  }

  console.log(`\n${options.dryRun ? "Would split" : "Split"} names\n`);
  console.log(`  read                  ${stats.read}`);
  console.log(`  already split         ${stats.alreadySplit}`);
  console.log(`  ${options.dryRun ? "would write" : "written"}           ${stats.written}`);
  console.log(`  skipped, unresolved   ${stats.skippedLowConfidence}`);
  console.log(`\n  by basis:`, byBasis);
  console.log(`  by order:`, byOrder);

  if (samples.length) {
    console.log(`\nFirst ${samples.length}:`);
    for (const sample of samples) console.log(sample);
  }

  const attempted = stats.read - stats.alreadySplit;
  if (attempted > 0) {
    const rate = (stats.written / attempted) * 100;
    console.log(`\n  resolved ${rate.toFixed(1)}% of the names it looked at.`);
    /*
     * A collapse here means the lexicon inverted or the import changed shape.
     * Better to say so than to leave the reader comparing two large numbers.
     */
    if (rate < 80) {
      console.log(
        `  That is low. Check that \`npm run build:given-names\` still puts ` +
          `surnames and given names on the sides it says it does.`,
      );
    }
  }
}

main();
