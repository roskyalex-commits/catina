/**
 * Removes the tech-stack signals that were never really signals.
 *
 *   npm run repair:tech-signals -- --dry-run
 *   npm run repair:tech-signals
 *
 * `TechStackSignalSource` had two defects and the database is full of their
 * output. Both are fixed in the source; this deletes what they already wrote.
 *
 * **1. The diff ran against an empty previous stack.** `isApplicable` gated on
 * `Boolean(context.previous?.techStack)`, and `Boolean([])` is true — so a
 * first scan that detected nothing let the *next* scan report the site's entire
 * stack as newly added. 241 companies carry "Started using WordPress" and 102
 * carry "Started using Apache". Those are first observations wearing a change's
 * clothes.
 *
 * **2. Commodity infrastructure counted.** Apache, nginx, PHP, WordPress,
 * Cloudflare and Google Analytics are on half the web. Adding one says nothing
 * about whether a company is buying anything.
 *
 * Neither failed loudly. The score absorbed them, the SIGNAL column rendered
 * them, and the cost only became visible at the last possible moment: **72 of
 * 101 mid-market messages would have opened with "I saw you started using
 * Apache"**.
 *
 * ## Why it deletes everything rather than rewriting the good ones
 *
 * The first version of this script kept 207 signals that named a real platform
 * — `Started using Apache, PHP, WooCommerce, WordPress` retitled to
 * `Started using WooCommerce` — on the theory that the platform half was true
 * and only the framing was noisy.
 *
 * Then the theory was checked against the data. For **574 of 574** signals, the
 * `added` list is *identical to the company's entire current tech stack*. Not
 * one is a subset. Every one was diffed against nothing.
 *
 * So "Started using WooCommerce" is not a noisy true statement; it is a
 * confident false one, about a company that may have run WooCommerce for five
 * years. That is worse than the Apache line, not better, because a stranger
 * reading it can tell it is wrong.
 *
 * Nothing survives. A genuine adoption will be found by the next
 * `scan:signals`, which now diffs against a stack that actually contains
 * something.
 *
 * Run `npm run rescore:leads` afterwards. Scores will fall, and that is the
 * correction working: those points were awarded for nothing.
 */
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./load-env";

const PAGE = 1000;
const WRITE_BATCH = 200;

const TYPES = ["tech_stack_added", "tech_stack_removed"] as const;

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

type SignalRow = {
  id: string;
  companyId: string;
  type: string;
  title: string;
  payload: { added?: string[]; removed?: string[]; notable?: string[] } | null;
};

async function loadAll(): Promise<SignalRow[]> {
  const rows: SignalRow[] = [];
  // Paged: PostgREST caps a select at 1,000 rows silently, and a repair that
  // sees a fraction of the table looks exactly like a repair that worked.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("signals")
      .select("id, company_id, type, title, payload")
      .in("type", TYPES as unknown as string[])
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) {
      console.error(`Could not read signals: ${error.message}`);
      process.exit(1);
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(
      ...batch.map((row) => ({
        id: String(row.id),
        companyId: String(row.company_id),
        type: String(row.type),
        title: String(row.title ?? ""),
        payload: (row.payload ?? null) as SignalRow["payload"],
      })),
    );
    if (batch.length < PAGE) break;
  }
  return rows;
}

/**
 * Prove, per row, that the diff ran against an empty previous stack.
 *
 * `company_scans` keys on `company_id` and holds one row, so there is no scan
 * history to consult — but there is a decisive test available anyway: if the
 * signal's `added` list contains the company's *entire current* stack, then
 * nothing was subtracted from it, which means it was compared against nothing.
 *
 * Checked rather than assumed, because deleting real signals to fix fake ones
 * would be its own bug. On this database it holds for 574 of 574.
 */
async function diffedAgainstNothing(rows: SignalRow[]): Promise<Set<string>> {
  const ids = [...new Set(rows.map((row) => row.companyId))];
  const stacks = new Map<string, string[]>();

  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("company_scans")
      .select("company_id, tech_stack")
      .in("company_id", ids.slice(i, i + 200));

    if (error) {
      console.error(`Could not read company_scans: ${error.message}`);
      process.exit(1);
    }
    for (const row of (data ?? []) as { company_id: string; tech_stack: string[] | null }[]) {
      stacks.set(row.company_id, row.tech_stack ?? []);
    }
  }

  const proven = new Set<string>();
  for (const row of rows) {
    const current = stacks.get(row.companyId);
    const changed =
      row.type === "tech_stack_added" ? row.payload?.added : row.payload?.removed;
    if (!current?.length || !changed?.length) continue;
    if (current.every((tech) => changed.includes(tech))) proven.add(row.id);
  }
  return proven;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = await loadAll();

  console.log(`${rows.length} tech-stack signals on file\n`);
  if (rows.length === 0) return;

  const proven = await diffedAgainstNothing(rows);
  const unproven = rows.filter((row) => !proven.has(row.id));

  console.log(
    `  ${String(proven.size).padStart(5)}  provably diffed against an empty stack — delete\n` +
      `  ${String(unproven.length).padStart(5)}  could not be proven either way — keep, and look\n`,
  );

  console.log("about to delete, for example:");
  for (const row of rows.filter((r) => proven.has(r.id)).slice(0, 8)) {
    console.log(`  ${row.title}`);
  }

  if (unproven.length > 0) {
    /*
     * Deliberately kept. This script's justification is a measurement, and a
     * row the measurement does not cover has not earned deletion — it has
     * earned somebody looking at it.
     */
    console.log(`\nkeeping these, which the test could not account for:`);
    for (const row of unproven.slice(0, 8)) console.log(`  ${row.title}`);
  }

  if (options.dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }

  const doomed = rows.filter((row) => proven.has(row.id)).map((row) => row.id);
  let deleted = 0;
  for (let i = 0; i < doomed.length; i += WRITE_BATCH) {
    const ids = doomed.slice(i, i + WRITE_BATCH);
    const { error } = await db.from("signals").delete().in("id", ids);
    if (error) {
      console.error(`\nDeleting failed at row ${i}: ${error.message}`);
      process.exit(1);
    }
    deleted += ids.length;
    process.stdout.write(`\r  deleted ${deleted}/${doomed.length}`);
  }

  console.log(
    `\n\n${deleted} deleted, ${unproven.length} kept.\n\n` +
      `Scores are now stale — those points were awarded for nothing:\n` +
      `  npm run rescore:leads`,
  );
}

main();
