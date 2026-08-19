/**
 * Re-scores leads against the signals a scan found.
 *
 *   npm run rescore:leads -- --dry-run
 *   npm run rescore:leads
 *
 * Scoring happens once, when a lead is created, so signals discovered after
 * that never reach the number the user sorts by. This closes that gap the same
 * way enrichment does: recompute the one component that moved and carry the
 * rest verbatim, rather than re-deriving a whole score from a second read of
 * the agent and the company.
 *
 * Idempotent — a lead with no new signals produces an identical breakdown and
 * the write is skipped, so running it twice costs two reads and no writes.
 */
import { createClient } from "@supabase/supabase-js";
import { findSignalsFor } from "../src/lib/signals/repository";
import { rescoreWithSignals, type ScoreBreakdown } from "../src/lib/signals/scoring";
import { requireEnv } from "./load-env";

const PAGE = 1000;

type Options = { limit?: number; dryRun: boolean; orgId?: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--limit":
        options.limit = Number(next());
        break;
      case "--org":
        options.orgId = next();
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

type LeadRow = {
  id: string;
  company_id: string;
  score: number;
  score_breakdown: ScoreBreakdown | null;
};

async function loadLeads(options: Options): Promise<LeadRow[]> {
  const leads: LeadRow[] = [];

  for (let from = 0; ; from += PAGE) {
    const wanted = options.limit ? Math.min(PAGE, options.limit - leads.length) : PAGE;
    if (wanted <= 0) break;

    let query = db
      .from("leads")
      .select("id, company_id, score, score_breakdown")
      .order("id", { ascending: true })
      .range(from, from + wanted - 1);
    if (options.orgId) query = query.eq("org_id", options.orgId);

    const { data, error } = await query;
    if (error) {
      console.error(`Could not read leads: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as LeadRow[];
    leads.push(...rows);
    if (rows.length < wanted) break;
  }
  return leads;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const leads = await loadLeads(options);
  console.log(`${leads.length} leads\n`);
  if (leads.length === 0) return;

  const signalsByCompany = await findSignalsFor(
    db,
    leads.map((lead) => lead.company_id),
  );
  const withSignals = leads.filter((lead) => signalsByCompany.has(lead.company_id));
  console.log(
    `${signalsByCompany.size} of their companies have signals; ` +
      `${withSignals.length} leads are affected\n`,
  );

  let moved = 0;
  let disqualified = 0;
  let totalGain = 0;
  const examples: string[] = [];

  for (const lead of leads) {
    // A lead with no stored breakdown was written before scoring recorded one;
    // there is nothing to carry forward, so leave it for a full re-source.
    if (!lead.score_breakdown) continue;

    const signals = signalsByCompany.get(lead.company_id) ?? [];
    const before = lead.score;
    const breakdown = rescoreWithSignals(lead.score_breakdown, signals);
    if (breakdown.total === before) continue;

    moved += 1;
    totalGain += breakdown.total - before;
    if (breakdown.disqualified) disqualified += 1;
    if (examples.length < 12 && breakdown.total > before) {
      examples.push(
        `  ${String(before).padStart(3)} → ${String(breakdown.total).padStart(3)}  ` +
          `${signals.map((s) => s.type).join(", ").slice(0, 60)}`,
      );
    }

    if (options.dryRun) continue;

    const { error } = await db
      .from("leads")
      .update({ score: breakdown.total, score_breakdown: breakdown })
      .eq("id", lead.id);
    if (error) console.error(`\n  ${lead.id}: ${error.message}`);
  }

  console.log(
    `${moved} leads changed score` +
      (disqualified ? `, ${disqualified} disqualified by a distress signal` : "") +
      `\naverage movement: ${moved ? (totalGain / moved).toFixed(1) : "0"} points\n`,
  );
  for (const example of examples) console.log(example);
  if (options.dryRun) console.log("\nDry run — nothing was written.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
