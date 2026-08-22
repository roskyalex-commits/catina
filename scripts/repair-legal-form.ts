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
 * `canonicalLegalForm` is the fix going forward and every writer goes through
 * it. This rewrites what is already stored.
 *
 * ## Why this one talks SQL and the other repairs do not
 *
 * Rewriting one column across 309,654 rows is a *set* operation. The first
 * version did it the way every other script here does — read the rows over
 * PostgREST, map them in JavaScript, send an `UPDATE … WHERE id = ?` per row —
 * and that is 309,654 HTTP round trips for a change Postgres can make in a
 * single statement per distinct value. It was still running after twenty
 * minutes, and it starved every other query on the free tier while it did.
 *
 * `DATABASE_URL` is already how migrations run, so this is not a new access
 * path, just the right one for the shape of the work. Read scripts keep using
 * PostgREST; a bulk column rewrite should not.
 *
 * ## What it clears rather than maps
 *
 * ANAF files `ALTE FORME JURIDICE` for 802 companies and `N/A` for 52, plus an
 * empty string for 47,348. None of those is a legal form. They become null,
 * because `--legal-form` excludes unknowns on purpose — a value recording "we
 * do not know" must not read as one recording an answer.
 *
 * Idempotent: a second run reports nothing to change.
 */
import postgres from "postgres";
import { canonicalLegalForm } from "../src/lib/sources/legal-form";
import { requireEnv } from "./load-env";

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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const sql = postgres(
    requireEnv("DATABASE_URL", "The same connection string db:migrate uses."),
    { ssl: "require", max: 1 },
  );

  try {
    /*
     * One row per distinct value, not per company. There are 28 of them across
     * 351,694 companies, so the decision about what each becomes is made 28
     * times in JavaScript and applied 28 times in SQL.
     */
    const distinct = await sql<{ legal_form: string | null; n: number }[]>`
      select legal_form, count(*)::int as n
      from companies
      where legal_form is not null
      group by legal_form
      order by n desc
    `;

    const changes = distinct
      .map((row) => ({
        from: row.legal_form,
        to: canonicalLegalForm(row.legal_form) ?? null,
        n: row.n,
      }))
      .filter((change) => change.to !== change.from);

    const total = changes.reduce((sum, change) => sum + change.n, 0);

    console.log(`${distinct.length} distinct values across the column\n`);
    console.log(`${total} rows to change, in ${changes.length} statements:\n`);
    for (const change of changes) {
      const label = `${change.from === "" ? "(empty)" : change.from} -> ${change.to ?? "(cleared)"}`;
      console.log(`  ${String(change.n).padStart(7)}  ${label.slice(0, 74)}`);
    }

    if (options.dryRun) {
      console.log("\n--dry-run: nothing was written.");
      return;
    }
    if (changes.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    let written = 0;
    for (const change of changes) {
      const result = await sql`
        update companies
        set legal_form = ${change.to}
        where legal_form = ${change.from}
      `;
      written += result.count;
      console.log(`  ${String(result.count).padStart(7)}  ${change.from === "" ? "(empty)" : change.from}`);
    }

    console.log(`\n${written} rows folded back to one vocabulary.`);
  } finally {
    await sql.end();
  }
}

main();
