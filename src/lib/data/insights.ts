import { getSessionContext } from "@/lib/supabase/server";
import { optionalString } from "@/lib/supabase/row";
import { demoDataset, isDemoMode } from "./demo";
import { RANGE_DAYS } from "./types";
import type { InsightsData, LaunchChip, RangeKey } from "./types";

const DAY = 86_400_000;

/**
 * A YYYY-MM-DD key in local time. See the note in `dashboard.ts`: using
 * `toISOString()` on a local midnight silently shifts the whole grid a day.
 */
function localIso(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The per-agent launch grid.
 *
 * Columns run newest-first, matching the reference: the user cares what
 * happened today and scans left to right into the past.
 */
export async function getInsights(range: RangeKey = "30d"): Promise<InsightsData> {
  const dayCount = Math.min(7, RANGE_DAYS[range]);
  const base = new Date();
  base.setHours(0, 0, 0, 0);

  const days = Array.from({ length: dayCount }, (_, i) => {
    const day = new Date(base.getTime() - i * DAY);
    return {
      iso: localIso(day),
      day: day
        .toLocaleDateString("en-GB", { month: "short", day: "numeric" })
        .toUpperCase(),
      weekday: day.toLocaleDateString("en-GB", { weekday: "short" }),
    };
  });

  if (!isDemoMode()) return await liveInsights(range, days);

  const { contacts, agents, activeSignals } = demoDataset();
  const totalLeads = contacts.length * 21;

  const rows = agents.map((agent) => {
    const cells: Record<string, LaunchChip[]> = {};

    days.forEach((day, dayIndex) => {
      // Today is still in progress; the reference shows an em-dash for it.
      if (dayIndex === 0) {
        cells[day.iso] = [];
        return;
      }

      // A paused agent launched nothing. Showing it a full grid of results
      // would contradict the status pill three columns to the left.
      const running = agent.status === "active";

      const chips: LaunchChip[] = agent.sources.keywords.map((keyword, i) => ({
        query: `"${keyword}"`,
        label: "Engagement & Intent",
        // Most keyword launches find nothing on a given day. Saying so is the
        // point of this grid — it shows which keywords are dead.
        count: running && (dayIndex + i) % 4 === 0 ? (dayIndex + i) % 7 : 0,
      }));

      chips.push({
        query: agent.name,
        label: "Lookalike match",
        count: running ? 18 + ((dayIndex * 3) % 9) : 0,
      });

      if (running && dayIndex % 3 === 1) {
        chips.push({
          query: "Autopilot",
          label: "Top 5% of ICP",
          count: 40 + ((dayIndex * 7) % 12),
        });
      }

      cells[day.iso] = chips;
    });

    return {
      agentId: agent.id,
      agentName: agent.name,
      status: agent.status,
      cells,
    };
  });

  return {
    totalLeads,
    avgPerDay: Math.round(totalLeads / Math.max(1, RANGE_DAYS[range])),
    activeSignals,
    days,
    rows,
  };
}

/**
 * The launch grid from `job_runs`.
 *
 * One row per agent, one cell per day, one chip per launch. A day with no
 * launch is genuinely empty rather than absent — the grid exists to show which
 * targeting is producing nothing, so a blank cell is information.
 */
async function liveInsights(
  range: RangeKey,
  days: { iso: string; day: string; weekday: string }[],
): Promise<InsightsData> {
  const session = await getSessionContext();
  const empty: InsightsData = {
    totalLeads: 0,
    avgPerDay: 0,
    activeSignals: 0,
    days,
    rows: [],
  };
  if (!session?.orgId) return empty;

  const { supabase, orgId } = session;
  const since = new Date(days.at(-1)?.iso ?? new Date().toISOString());

  const [agents, runs, signals] = await Promise.all([
    supabase
      .from("agents")
      .select("id, name, status")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("created_at", { ascending: false }),
    supabase
      .from("job_runs")
      .select("agent_id, source_label, source_query, leads_found, created_at")
      .eq("org_id", orgId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.from("signals").select("id", { count: "exact", head: true }),
  ]);

  const runRows = (runs.data ?? []) as Record<string, unknown>[];
  const totalLeads = runRows.reduce(
    (sum, run) => sum + Number(run.leads_found ?? 0),
    0,
  );

  const rows = ((agents.data ?? []) as Record<string, unknown>[]).map((agent) => {
    const agentId = String(agent.id);
    const cells: Record<string, LaunchChip[]> = {};
    for (const day of days) cells[day.iso] = [];

    for (const run of runRows) {
      if (optionalString(run.agent_id) !== agentId) continue;
      const at = run.created_at ? new Date(String(run.created_at)) : null;
      if (!at || Number.isNaN(at.getTime())) continue;
      const iso = localIso(at);
      if (!cells[iso]) continue;

      cells[iso].push({
        query: optionalString(run.source_query) ?? String(agent.name),
        label:
          optionalString(run.source_label) === "keyword"
            ? "Engagement & Intent"
            : "Top 5% of ICP",
        count: Number(run.leads_found ?? 0),
      });
    }

    const status = optionalString(agent.status);
    return {
      agentId,
      agentName: String(agent.name),
      status: (status === "active" || status === "paused" ? status : "draft") as
        InsightsData["rows"][number]["status"],
      cells,
    };
  });

  return {
    totalLeads,
    avgPerDay: Math.round(totalLeads / Math.max(1, RANGE_DAYS[range])),
    activeSignals: signals.count ?? 0,
    days,
    rows,
  };
}
