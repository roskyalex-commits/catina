/**
 * Turns leads into drafted messages.
 *
 *   npm run outreach:draft -- --agent <id> --dry-run     # who qualifies, and why not
 *   npm run outreach:draft -- --agent <id> --limit 10    # write 10 drafts
 *
 * Nothing here sends. It writes `messages` rows in state `drafted`, scheduled
 * across the next working day. `npm run outreach:send` is the half that talks
 * to Gmail, and keeping them apart means you can generate a hundred messages
 * and read them all before any of them can leave.
 *
 * ## Start with --dry-run, every time
 *
 * The interesting output is the skip breakdown, not the drafts. On this data
 * most leads are ineligible and the reason is the finding: `unverified_email`
 * dominating means the bottleneck is verification credits, `no_signal` means
 * the scan needs re-running, `already_messaged` means the campaign is done.
 * A dry run costs two reads and no model calls.
 *
 * ## What it costs
 *
 * One Claude call per draft, and no way around that: the whole claim is that
 * the opening line is built from a specific fact about this company, which is
 * not a merge field. `--limit` is the budget control and it defaults low.
 */
import { createClient } from "@supabase/supabase-js";
import { draftMessage } from "../src/lib/outreach/draft";
import {
  OUTREACH_LEAD_COLUMNS,
  SENDABLE_STATUSES,
  UNVERIFIED_STATUSES,
  alreadyMessaged,
  draftLanguageFor,
  eligibleForOutreach,
  ensureCampaign,
  outreachLeadFrom,
  queueDrafts,
  signalIdsByKey,
  type OutreachLead,
  type QueuedDraft,
  type SkipCode,
} from "../src/lib/outreach/pipeline";
import { nextBusinessDay, scheduleSendTimes } from "../src/lib/outreach/send-guard";
import { suppressedAmong } from "../src/lib/outreach/suppressions";
import { findSignalsFor } from "../src/lib/signals/repository";
import type { Signal } from "../src/lib/signals/types";
import { requireEnv } from "./load-env";

/** Low on purpose: every draft is a paid model call. */
const DEFAULT_LIMIT = 10;
/** How many leads to consider for each one we can draft. */
const CANDIDATE_MULTIPLE = 40;

type Options = {
  agentId?: string;
  limit: number;
  dryRun: boolean;
  allowUnverified: boolean;
  minScore?: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { limit: DEFAULT_LIMIT, dryRun: false, allowUnverified: false };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[(i += 1)];
    switch (argv[i]) {
      case "--agent":
        options.agentId = next();
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--min-score":
        options.minScore = Number(next());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--allow-unverified":
        options.allowUnverified = true;
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

const SKIP_LABELS: Record<SkipCode, string> = {
  no_email: "no email address",
  unverified_email: "address never confirmed",
  no_signal: "no signal to open with",
  distress: "company in distress",
  suppressed: "on the do-not-contact list",
  already_messaged: "already written to",
  no_name: "no person or company name",
  rejected: "lead rejected",
};

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const agent = await loadAgent(options.agentId);
  if (!agent) process.exit(1);

  console.log(`Agent: ${agent.name}`);
  console.log(
    `Addresses allowed: ${(options.allowUnverified ? UNVERIFIED_STATUSES : SENDABLE_STATUSES).join(", ")}` +
      (options.allowUnverified
        ? "\n  --allow-unverified is on. A `pattern` address is a guess nothing confirmed;\n" +
          "  bouncing them is the fastest way to make every later message land in spam."
        : ""),
  );

  const campaign = await ensureCampaign(db, {
    orgId: agent.orgId,
    agentId: agent.id,
    name: agent.name,
  });
  if (!campaign) {
    console.error("Could not find or create a campaign for this agent.");
    process.exit(1);
  }

  const leads = await loadLeads(agent, options);
  console.log(`\n${leads.length} leads considered\n`);
  if (leads.length === 0) return;

  // Three batched reads for the whole candidate set, rather than three queries
  // per lead. Signals and suppression both answer for the batch.
  const signalsByCompany = await findSignalsFor(
    db,
    leads.map((lead) => lead.companyId),
  );
  const suppressed = await suppressedAmong(
    db,
    agent.orgId,
    leads.map((lead) => lead.email?.address ?? "").filter(Boolean),
  );
  const messaged = await alreadyMessaged(
    db,
    campaign.id,
    leads.map((lead) => lead.leadId),
  );

  const allowedStatuses = options.allowUnverified ? UNVERIFIED_STATUSES : SENDABLE_STATUSES;
  const skips = new Map<SkipCode, number>();
  const eligible: { lead: OutreachLead; signal: Signal }[] = [];

  for (const lead of leads) {
    const verdict = eligibleForOutreach(lead, {
      signals: signalsByCompany.get(lead.companyId) ?? [],
      suppressed: suppressed.has((lead.email?.address ?? "").toLowerCase()),
      alreadyMessaged: messaged.has(lead.leadId),
      allowedStatuses,
    });

    if (!verdict.ok) {
      skips.set(verdict.code, (skips.get(verdict.code) ?? 0) + 1);
      continue;
    }
    eligible.push({ lead, signal: verdict.signal });
  }

  console.log(`Eligible: ${eligible.length}`);
  if (skips.size > 0) {
    console.log("\nSkipped:");
    for (const [code, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${SKIP_LABELS[code]}`);
    }
  }

  const chosen = eligible.slice(0, options.limit);
  if (chosen.length === 0) {
    console.log("\nNothing to draft.");
    return;
  }

  console.log(`\nDrafting ${chosen.length}:`);
  for (const item of chosen) {
    console.log(
      `  ${item.lead.fullName.slice(0, 24).padEnd(26)} ${item.lead.companyName.slice(0, 24).padEnd(26)} ${item.signal.title.slice(0, 40)}`,
    );
  }

  if (options.dryRun) {
    console.log("\n--dry-run: no model calls made, nothing written.");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "\nANTHROPIC_API_KEY is not set. Drafting builds each opening line from the\n" +
        "signal, which is a model call — there is no template fallback by design.",
    );
    process.exit(1);
  }

  /*
   * Spread over the next working day, not this one. A run at 22:00 that
   * schedules everything for "now" produces a batch of 3am mail, and weekend
   * B2B mail is read on Monday if at all — `nextBusinessDay` is what keeps the
   * schedule looking like a person wrote it.
   */
  const times = scheduleSendTimes({
    count: chosen.length,
    dayStart: nextBusinessDay(new Date()),
  });

  // So each message can link back to the evidence it was built from.
  const signalIds = await signalIdsByKey(
    db,
    chosen.map((item) => item.signal.dedupeKey),
  );

  const drafts: QueuedDraft[] = [];
  let failed = 0;

  for (const [index, item] of chosen.entries()) {
    const signal = item.signal;

    try {
      const draft = await draftMessage(
        {
          valueProp: agent.valueProp,
          senderName: agent.senderName,
          senderCompany: agent.productName ?? undefined,
          recipientName: item.lead.fullName,
          recipientTitle: item.lead.title ?? undefined,
          companyName: item.lead.companyName,
          signal,
          language: draftLanguageFor(item.lead.country),
        },
        apiKey,
      );

      drafts.push({
        lead: item.lead,
        draft,
        signalId: signalIds.get(signal.dedupeKey) ?? null,
        scheduledFor: times[index] ?? new Date(),
      });
      console.log(`\n  ${item.lead.fullName} — ${draft.subject}`);
      console.log(`  ${draft.body.split("\n")[0]?.slice(0, 90) ?? ""}`);
    } catch (error) {
      // One bad draft must not lose the rest of the run. `normalise` throws on
      // a leaked placeholder, and discarding that draft is the correct outcome.
      failed += 1;
      console.error(
        `\n  ${item.lead.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const written = await queueDrafts(db, {
    orgId: agent.orgId,
    campaignId: campaign.id,
    drafts,
  });

  if (written.error) {
    console.error(`\n${written.error}`);
    process.exit(1);
  }

  console.log(
    `\n${"-".repeat(64)}\n${written.written} drafted, ${failed} discarded.\n` +
      `Scheduled from ${times[0]?.toLocaleString() ?? "now"}.\n\n` +
      `Read them before anything sends:\n` +
      `  npm run outreach:send -- --agent ${agent.id} --dry-run`,
  );
}

type Agent = {
  id: string;
  orgId: string;
  name: string;
  valueProp: string;
  productName: string | null;
  senderName: string;
};

/** The agent to draft for — named, or the only active one. */
async function loadAgent(agentId?: string): Promise<Agent | null> {
  let query = db
    .from("agents")
    .select("id, org_id, name, value_prop, product_name")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(agentId ? 1 : 2);
  if (agentId) query = query.eq("id", agentId);

  const { data, error } = await query;
  if (error) {
    console.error(`Could not read agents: ${error.message}`);
    return null;
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    console.error(agentId ? `No such agent: ${agentId}` : "No active agents.");
    return null;
  }
  if (!agentId && rows.length > 1) {
    console.error(
      "Several active agents. Name one with --agent <id>; they target different\n" +
        "markets and drafting for the wrong one is a wasted model call at best.",
    );
    return null;
  }

  const row = rows[0];
  const valueProp = typeof row.value_prop === "string" ? row.value_prop.trim() : "";
  if (!valueProp) {
    // Without it the model has nothing to connect the signal to, and produces
    // the generic pitch this whole file exists to avoid.
    console.error(
      `Agent "${row.name}" has no value proposition recorded. Run the onboarding\n` +
        "analysis, or set `value_prop` — the drafter has nothing to offer without it.",
    );
    return null;
  }

  return {
    id: String(row.id),
    orgId: String(row.org_id),
    name: typeof row.name === "string" ? row.name : "Agent",
    valueProp,
    productName: typeof row.product_name === "string" ? row.product_name : null,
    senderName: typeof row.product_name === "string" ? row.product_name : String(row.name),
  };
}

async function loadLeads(agent: Agent, options: Options): Promise<OutreachLead[]> {
  /*
   * Reads more leads than we intend to draft, because most will be ineligible —
   * on the current data roughly one lead in ten has an address we would mail.
   * Ordered by score so the ones we do draft are the best available, not the
   * first ones the index happened to return.
   */
  const want = Math.max(options.limit * CANDIDATE_MULTIPLE, 200);

  let query = db
    .from("leads")
    .select(OUTREACH_LEAD_COLUMNS)
    .eq("org_id", agent.orgId)
    .eq("agent_id", agent.id)
    .neq("status", "rejected")
    .order("score", { ascending: false })
    .limit(Math.min(want, 1000));

  if (options.minScore !== undefined) query = query.gte("score", options.minScore);

  const { data, error } = await query;
  if (error) {
    console.error(`Could not read leads: ${error.message}`);
    return [];
  }
  return (data ?? []).map((row) => outreachLeadFrom(row as Record<string, unknown>));
}

main();
