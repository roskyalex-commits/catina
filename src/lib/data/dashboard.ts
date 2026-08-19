import { demoDataset, isDemoMode } from "./demo";
import { hotContacts } from "./contacts";
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

  if (!demo) {
    // TODO(persistence): aggregate leads, job_runs and messages for the org.
    return {
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
  }

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
