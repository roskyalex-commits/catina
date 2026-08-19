import { getSessionContext } from "@/lib/supabase/server";
import { demoDataset, isDemoMode } from "./demo";
import { hotContacts, topContacts } from "./contacts";
import { SCORE_BANDS } from "./score";
import { RANGE_DAYS } from "./types";
import type { ChartData, DashboardData, RangeKey } from "./types";

const DAY = 86_400_000;

const EMPTY_CHART: ChartData = { labels: [], series: [] };

/**
 * The four series are not the reference product's four.
 *
 * Theirs are Leads created / Invitations sent / Messages sent / Emails sent,
 * where "invitations" and two of the message counts are LinkedIn. We have no
 * lawful free source for LinkedIn activity, so plotting it would draw three
 * flat lines forever. These four are things this system actually does.
 */
const SERIES_META = [
  { key: "leads", label: "Leads created", color: "--series-leads" },
  { key: "companies", label: "Companies sourced", color: "--series-invites" },
  { key: "signals", label: "Signals detected", color: "--series-messages" },
  { key: "emails", label: "Emails sent", color: "--series-emails" },
] as const;

export async function getDashboard(
  range: RangeKey = "30d",
): Promise<DashboardData> {
  const demo = isDemoMode();

  if (!demo) return await liveDashboard(range);

  const { contacts, agents, activeSignals } = demoDataset();
  const days = RANGE_DAYS[range];
  const active = agents.filter((a) => a.status === "active");
  const nextLaunch = active
    .map((a) => a.nextLaunchAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    greetingName: "Alex",
    activeSignals,
    mailboxConnected: agents.some((a) => a.mailbox !== null),
    nextActions: {
      pendingTasks: agents.reduce((sum, a) => sum + a.queue.length, 0),
      nextLaunchAt: nextLaunch ?? null,
      companiesSourced: contacts.length * 7,
      messagesDrafted: agents.reduce((sum, a) => sum + a.queue.length, 0),
    },
    hotOpportunities: contacts.filter((c) => c.score >= SCORE_BANDS.hot).length,
    leadsEngaged: agents.reduce((sum, a) => sum + a.stats.contacted, 0),
    // Replies need Gmail read access, a restricted scope. Honestly zero.
    conversations: 0,
    pipeline: { valueEur: null, dealSizeSet: false },
    chart: buildChart(days),
    hotLeads: await hotContacts(5),
    replies: [],
  };
}


/**
 * The dashboard from the database.
 *
 * Every number here is counted, not estimated. Where a number cannot be known
 * yet it stays zero or null rather than being inferred: `conversations` needs
 * Gmail read access we deliberately do not request, and `pipeline` needs a deal
 * size the user has not set.
 */
async function liveDashboard(range: RangeKey): Promise<DashboardData> {
  const session = await getSessionContext();
  const empty: DashboardData = {
    greetingName: "there",
    activeSignals: 0,
    mailboxConnected: false,
    nextActions: {
      pendingTasks: 0,
      nextLaunchAt: null,
      companiesSourced: 0,
      messagesDrafted: 0,
    },
    hotOpportunities: 0,
    leadsEngaged: 0,
    conversations: 0,
    pipeline: { valueEur: null, dealSizeSet: false },
    chart: EMPTY_CHART,
    hotLeads: [],
    replies: [],
  };
  if (!session?.orgId) return empty;

  const { supabase, orgId } = session;
  const since = new Date(Date.now() - RANGE_DAYS[range] * DAY);
  const scoped = () => supabase.from("leads").select("id", { count: "exact", head: true }).eq("org_id", orgId);

  const [newLeads, hot, engaged, runs, agents, signals, drafts, leads] =
    await Promise.all([
      scoped().eq("status", "new"),
      scoped().gte("score", SCORE_BANDS.hot),
      scoped().in("status", ["queued", "sent", "replied"]),
      supabase
        .from("job_runs")
        .select("id, kind, status, title, subtitle, leads_found, created_at")
        .eq("org_id", orgId)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(500),
      supabase
        .from("agents")
        .select("next_launch_at, email_account_id")
        .eq("org_id", orgId)
        .eq("is_active", true),
      supabase.from("signals").select("id", { count: "exact", head: true }),
      supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("state", "drafted"),
      scoped(),
    ]);

  const runRows = (runs.data ?? []) as Record<string, unknown>[];
  const agentRows = (agents.data ?? []) as Record<string, unknown>[];

  const nextLaunch = agentRows
    .map((agent) => (agent.next_launch_at ? new Date(String(agent.next_launch_at)) : null))
    .filter((date): date is Date => date !== null && !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    greetingName: (session.user.email ?? "there").split("@")[0] ?? "there",
    activeSignals: signals.count ?? 0,
    mailboxConnected: agentRows.some((agent) => agent.email_account_id !== null),
    nextActions: {
      pendingTasks: newLeads.count ?? 0,
      nextLaunchAt: nextLaunch ?? null,
      // Companies the agent actually looked at, summed from the runs
      // themselves rather than guessed from the lead count.
      companiesSourced: runRows.reduce((sum, run) => {
        const stats = run.stats as { companiesConsidered?: number } | null;
        return sum + (stats?.companiesConsidered ?? 0);
      }, 0),
      messagesDrafted: drafts.count ?? 0,
    },
    hotOpportunities: hot.count ?? 0,
    leadsEngaged: engaged.count ?? 0,
    // Replies need Gmail read access, a restricted scope we do not request.
    conversations: 0,
    pipeline: { valueEur: null, dealSizeSet: false },
    chart: chartFromRuns(runRows, RANGE_DAYS[range]),
    // Falls back to the best available when nothing is hot yet, so a working
    // agent does not present an empty card.
    hotLeads: (leads.count ?? 0) > 0 ? await topContacts(5) : [],
    replies: [],
  };
}

/**
 * Plot what actually happened, one point per day.
 *
 * Only two of the four series can be filled from `job_runs` today — leads and
 * companies. Signals and emails stay flat at zero because no scan and no send
 * has run, which is the truth and reads as such.
 */
function chartFromRuns(
  runs: Record<string, unknown>[],
  days: number,
): ChartData {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const labels: string[] = [];
  const buckets = new Map<string, { leads: number; companies: number }>();

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(base.getTime() - i * DAY);
    const iso = day.toISOString().slice(0, 10);
    labels.push(day.toLocaleDateString("en-GB", { month: "short", day: "numeric" }));
    buckets.set(iso, { leads: 0, companies: 0 });
  }

  for (const run of runs) {
    const at = run.created_at ? new Date(String(run.created_at)) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const bucket = buckets.get(at.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.leads += Number(run.leads_found ?? 0);
    const stats = run.stats as { companiesConsidered?: number } | null;
    bucket.companies += stats?.companiesConsidered ?? 0;
  }

  const ordered = [...buckets.values()];
  const points: Record<string, number[]> = {
    leads: ordered.map((bucket) => bucket.leads),
    companies: ordered.map((bucket) => bucket.companies),
    signals: ordered.map(() => 0),
    emails: ordered.map(() => 0),
  };

  return {
    labels,
    series: SERIES_META.map((meta) => ({
      key: meta.key,
      label: meta.label,
      color: meta.color,
      points: points[meta.key] ?? [],
    })),
  };
}

/**
 * Daily points across the range.
 *
 * Shaped rather than random: sourcing spikes when an agent launches and decays
 * as the registry slice is exhausted, which is what the real curve looks like
 * and what makes the chart legible at a glance.
 */
function buildChart(days: number): ChartData {
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const labels: string[] = [];
  const points: Record<string, number[]> = {
    leads: [],
    companies: [],
    signals: [],
    emails: [],
  };

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(base.getTime() - i * DAY);
    labels.push(day.toLocaleDateString("en-GB", { month: "short", day: "numeric" }));

    // Position within the range, 0 at the oldest day and 1 today.
    const t = days === 1 ? 1 : (days - 1 - i) / (days - 1);
    // One launch spike about two-thirds of the way in, then decay.
    const spike = Math.exp(-(((t - 0.68) * 6) ** 2));
    const tail = t > 0.68 ? Math.exp(-(t - 0.68) * 4) : 0;

    points.leads.push(Math.round(spike * 96 + tail * 22));
    points.companies.push(Math.round(spike * 41 + tail * 9));
    points.signals.push(Math.round(spike * 12 + tail * 4));
    points.emails.push(Math.round(t > 0.7 ? (t - 0.7) * 40 : 0));
  }

  return {
    labels,
    series: SERIES_META.map((meta) => ({
      key: meta.key,
      label: meta.label,
      color: meta.color,
      points: points[meta.key] ?? [],
    })),
  };
}
