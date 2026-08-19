import { demoDataset, isDemoMode } from "./demo";
import { RANGE_DAYS } from "./types";
import type { InsightsData, LaunchChip, RangeKey } from "./types";

const DAY = 86_400_000;

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
      iso: day.toISOString().slice(0, 10),
      day: day
        .toLocaleDateString("en-GB", { month: "short", day: "numeric" })
        .toUpperCase(),
      weekday: day.toLocaleDateString("en-GB", { weekday: "short" }),
    };
  });

  if (!isDemoMode()) {
    // TODO(persistence): group job_runs by agent and day.
    return { totalLeads: 0, avgPerDay: 0, activeSignals: 0, days, rows: [] };
  }

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
