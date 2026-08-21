/**
 * What email convention do Romanian companies actually use?
 *
 *   npm run measure:patterns
 *
 * ## Why this matters more than it looks
 *
 * `PATTERNS_BY_PREVALENCE` in `patterns.ts` orders twelve conventions by how
 * common each is, and that order was reasoned rather than measured — it is the
 * global folk wisdom, `first.last` first. Two things now depend on it being
 * right for this market specifically:
 *
 * The **guess-and-verify** loop tries conventions in that order and stops at
 * the first the mailbox confirms. Every position the true convention sits below
 * the top costs one verification credit per lead, against a free tier of 600 a
 * month. Getting the order right is worth more than any other tuning available.
 *
 * The **fallback confidences** in `generateCandidates` are invented constants
 * (0.35, 0.30, 0.25). A measured distribution replaces them with something that
 * means what it says.
 *
 * ## The gate
 *
 * Below `MIN_SAMPLE` inferred domains this reports and recommends nothing. A
 * distribution over thirty domains is noise, and the invented constants are no
 * worse than a confidently wrong measurement — the mistake this project has
 * already made once by quoting a hit rate measured on the wrong population.
 */
import { createClient } from "@supabase/supabase-js";
import { PATTERNS_BY_PREVALENCE } from "../src/lib/enrichment/patterns";
import { requireEnv } from "./load-env";

const PAGE = 1000;
/**
 * Below this, say so and recommend nothing.
 *
 * 100 domains puts the top convention's share inside roughly ±10 points at 95%
 * confidence, which is enough to reorder a list and not enough to tune a
 * confidence score to two decimal places.
 */
const MIN_SAMPLE = 100;

const db = createClient(
  requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

type Row = {
  email_pattern: string;
  email_pattern_source: string | null;
  email_pattern_samples: number;
  email_pattern_confidence: number | null;
  mx_provider: string | null;
};

async function load(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("company_scans")
      .select(
        "email_pattern, email_pattern_source, email_pattern_samples, email_pattern_confidence, mx_provider",
      )
      .not("email_pattern", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`company_scans: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as unknown as Row[]));
    if (data.length < PAGE) break;
  }
  return rows;
}

function tally<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function ranked(counts: Map<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function bar(share: number): string {
  return "#".repeat(Math.round(share * 40));
}

function report(label: string, rows: readonly Row[]) {
  if (rows.length === 0) return;
  console.log(`\n${label} (${rows.length} domains)`);
  for (const [pattern, count] of ranked(tally(rows, (row) => row.email_pattern))) {
    const share = count / rows.length;
    console.log(
      `  ${pattern.padEnd(12)} ${String(count).padStart(4)}  ` +
        `${(share * 100).toFixed(1).padStart(5)}%  ${bar(share)}`,
    );
  }
}

async function main() {
  const rows = await load();

  if (rows.length === 0) {
    console.error("No domain carries an inferred pattern. Run `npm run harvest:patterns` first.");
    process.exit(1);
  }

  console.log(`${rows.length} domains with a known convention\n`);

  /*
   * Split by how the pattern was arrived at, because they are different kinds
   * of evidence and averaging them would hide it. A `paired` pattern confirmed
   * an identity; a `shape` pattern only read like one.
   */
  const LABELS: Record<string, string> = {
    paired: "confirmed against a known person",
    shape: "read off an address shape",
    prior: "assumed from the measured distribution",
    inferred: "basis not recorded (harvested before the two were split)",
  };
  for (const [source, count] of ranked(
    tally(rows, (row) => row.email_pattern_source ?? "unknown"),
  )) {
    console.log(`  ${(LABELS[source] ?? source).padEnd(52)} ${String(count).padStart(4)}`);
  }

  report("Overall", rows);

  // Paired domains separately: the smaller, stronger sample. If it disagrees
  // with the overall order, the shape reader is biased and that is worth
  // knowing before either number is trusted.
  report("Confirmed pairs only", rows.filter((row) => row.email_pattern_source === "paired"));

  /*
   * Conditioned on where the mail lands. A Google Workspace tenant is a
   * deliberate IT decision and tends to come with a naming policy; a shared
   * cPanel host is whatever the person setting it up typed. If these differ,
   * the guess order should differ with them.
   */
  const providers = [...new Set(rows.map((row) => row.mx_provider ?? "unknown"))];
  for (const provider of providers.sort()) {
    const subset = rows.filter((row) => (row.mx_provider ?? "unknown") === provider);
    // Below 20 a per-provider split is decoration, not evidence.
    if (subset.length >= 20) report(`MX: ${provider}`, subset);
  }

  console.log(`\n${"-".repeat(60)}`);

  if (rows.length < MIN_SAMPLE) {
    console.log(
      `\nSample is ${rows.length}, below the ${MIN_SAMPLE} needed to recommend a\n` +
        `reordering. Reporting only — the constants in patterns.ts stay as they are.\n` +
        `Run \`npm run harvest:patterns\` to widen it.`,
    );
    return;
  }

  const observed = ranked(tally(rows, (row) => row.email_pattern)).map(([p]) => p);
  const current = PATTERNS_BY_PREVALENCE.filter((p) => observed.includes(p));

  console.log(`\nGuess order — what the code tries, against what the market does:\n`);
  console.log(`  code:     ${current.join(", ")}`);
  console.log(`  measured: ${observed.join(", ")}`);

  /*
   * Score the orders by what they cost, not by whether position 1 matches.
   *
   * An earlier version of this report compared only the first entry and
   * declared "nothing to change" while position *two* was demonstrably wrong —
   * the code tried `flast` (4.8% of domains) ahead of `first` (27.8%). Every
   * lead at a `first` company paid an extra verification credit for that, and
   * the report said everything was fine.
   *
   * Expected credits = sum over conventions of share x position, capped at the
   * three candidates `generateCandidates` actually produces. Anything past
   * three is never tried, so it cannot cost anything.
   */
  const shares = tally(rows, (row) => row.email_pattern);
  const MAX_GUESSES = 3;

  /*
   * Coverage first, cost second — and in that order for a reason.
   *
   * A convention outside the first three is never generated at all, so those
   * companies are simply unreachable by guessing. An earlier version of this
   * function summed `share x position` over the first three only, which scored
   * "never tried" as costing nothing and therefore made the *worse* order look
   * cheaper. Unreachable is not free; it is the most expensive outcome there is.
   */
  const score = (order: readonly string[]) => {
    const tried = order.slice(0, MAX_GUESSES);
    let reached = 0;
    let credits = 0;
    for (const [pattern, count] of shares) {
      const position = tried.indexOf(pattern);
      if (position < 0) continue;
      const share = count / rows.length;
      reached += share;
      credits += share * (position + 1);
    }
    return { reached, credits, tried };
  };

  const code = score(PATTERNS_BY_PREVALENCE);
  const best = score(observed);

  console.log(`\n  first ${MAX_GUESSES} guesses are all that are ever generated:\n`);
  console.log(`    code order      ${code.tried.join(", ")}`);
  console.log(
    `      reaches ${(code.reached * 100).toFixed(1)}% of domains, ` +
      `${code.credits.toFixed(2)} credits each`,
  );
  console.log(`    measured order  ${best.tried.join(", ")}`);
  console.log(
    `      reaches ${(best.reached * 100).toFixed(1)}% of domains, ` +
      `${best.credits.toFixed(2)} credits each`,
  );

  const gained = best.reached - code.reached;
  if (gained <= 0.01) {
    console.log(`\n  The current order already reaches as many domains. Nothing to change.`);
    return;
  }

  const missed = code.tried.length
    ? observed.filter((p) => !code.tried.includes(p)).slice(0, MAX_GUESSES)
    : [];

  console.log(
    `\n  ACTION: the code never generates ${missed.join(", ")}, so ` +
      `${(gained * 100).toFixed(1)}% of domains\n` +
      `  cannot be reached by guessing at all — not "costs more", cannot be reached.\n` +
      `  Set PATTERNS_BY_PREVALENCE in patterns.ts to lead with:\n` +
      `    ${best.tried.join(", ")}`,
  );
}

main();
