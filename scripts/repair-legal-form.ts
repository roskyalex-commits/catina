/**
 * Folds `companies.legal_form` back to one vocabulary.
 *
 *   npm run repair:legal-form -- --dry-run
 *   npm run repair:legal-form
 *
 * The column takes writes from two sources that disagree about spelling. ONRC's
 * `FORMA_JURIDICA` says `SRL`; ANAF says
 * `SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ`. Both are correct and they mean
 * the same thing.
 *
 * The column was added, filtered on and tested against ONRC's codes. ANAF
 * enrichment then ran over 309,598 companies and `legal_form = 'SRL'` went from
 * **291,272 rows to 31,976**, with 260,815 rows now saying the long name
 * instead. No error, no warning — a filter that had worked an hour earlier
 * simply stopped finding companies. Same shape as "CAEN is four registers
 * wearing one column" in docs/STATUS.md, reached from the other end.
 *
 * `canonicalLegalForm` is the fix going forward and every writer now goes
 * through it. This rewrites what is already stored.
 *
 * ## What it clears rather than maps
 *
 * ANAF files `ALTE FORME JURIDICE` for 802 companies and `N/A` for 52, plus an
 * empty string for 47,348. None of those is a legal form. They become null,
 * because `--legal-form` excludes unknowns on purpose — a value that records
 * "we do not know" must not be mistaken for one that records an answer.
 *
 * Idempotent: a second run finds nothing to change.
 */
import { createClient } from "@supabase/supabase-js";
import { canonicalLegalForm } from "../src/lib/sources/legal-form";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const WRITE_BATCH = 200;

type Options = { dryRun: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
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

type Row = { id: string; legal_form: string | null };

/**
 * Read every company that has a legal form, by keyset rather than by offset.
 *
 * PostgREST turns `.range(n, n + 999)` into `OFFSET n LIMIT 1000`, and Postgres
 * walks and discards those n rows on every page. Across 351,694 companies that
 * is quadratic, and it does not degrade gracefully — the first attempt at this
 * repair died with `canceling statement due to statement timeout` somewhere
 * past offset 300,000, having written nothing.
 *
 * `.gt("id", cursor)` is a range scan on the primary key: the same cost per
 * page whatever the table size. `AnafAdapter` already pages this way.
 */
async function readAll(): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;

  for (;;) {
    let query = db
      .from("companies")
      .select("id, legal_form")
      .not("legal_form", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (cursor) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read companies: ${error.message}`);
      process.exit(1);
    }

    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;

    cursor = batch[batch.length - 1].id;
    if (rows.length % 50_000 === 0) console.log(`  read ${rows.length}`);
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = await readAll();

  console.log(`${rows.length} companies with a legal form on file\n`);

  const fixes: { id: string; legal_form: string | null }[] = [];
  const moves = new Map<string, number>();

  for (const row of rows) {
    const wanted = canonicalLegalForm(row.legal_form) ?? null;
    if (wanted === row.legal_form) continue;
    fixes.push({ id: row.id, legal_form: wanted });
    const key = `${row.legal_form ?? "(null)"} -> ${wanted ?? "(cleared)"}`;
    moves.set(key, (moves.get(key) ?? 0) + 1);
  }

  console.log(`${fixes.length} to change:\n`);
  for (const [move, count] of [...moves].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(count).padStart(7)}  ${move.slice(0, 74)}`);
  }

  if (options.dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }
  if (fixes.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  let written = 0;
  for (let i = 0; i < fixes.length; i += WRITE_BATCH) {
    const batch = fixes.slice(i, i + WRITE_BATCH);
    const results = await Promise.all(
      batch.map((fix) =>
        db.from("companies").update({ legal_form: fix.legal_form }).eq("id", fix.id),
      ),
    );
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error(`\nWrite failed at ${i}: ${failed.error.message}`);
      console.error(`Wrote ${written} before failing. Re-running is safe.`);
      process.exit(1);
    }
    written += batch.length;
    if (written % 20_000 === 0) console.log(`  wrote ${written}/${fixes.length}`);
  }

  console.log(`\n${written} rows folded back to one vocabulary.`);
}

main();
