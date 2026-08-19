import { BarChart3, KeyRound, Target, TrendingUp, UserRound } from "lucide-react";
import { Card, EmptyState, PageHeader, Pill } from "@/components/ui/primitives";
import { StatTile } from "@/components/ui/stat";
import { getInsights } from "@/lib/data/insights";
import { RANGE_LABELS } from "@/lib/data/types";
import type { LaunchChip, RangeKey } from "@/lib/data/types";
import { STATUS_LABEL, STATUS_TONE } from "../agents/page";

/** Chips beyond this many collapse behind a "+N more launches" line. */
const CHIPS_SHOWN = 5;

function parseRange(value: string | undefined): RangeKey {
  return value && value in RANGE_LABELS ? (value as RangeKey) : "30d";
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const data = await getInsights(range);

  return (
    <>
      <PageHeader
        icon={BarChart3}
        title="Insights"
        description="Analytics and performance insights for your lead generation"
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          icon={UserRound}
          iconTone="info"
          label="Total Leads Generated"
          value={data.totalLeads}
          hint="in the selected period"
        />
        <StatTile
          icon={TrendingUp}
          iconTone="success"
          label="Avg Leads/Day"
          value={data.avgPerDay}
          hint="daily average"
        />
        <StatTile
          icon={KeyRound}
          iconTone="accent"
          label="Active Signals"
          value={data.activeSignals}
          hint="generating leads"
        />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border p-5">
          <h2 className="text-[15px] font-semibold">Daily Performance Overview</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Lead generation by agent across the selected date range
          </p>
        </div>

        {data.rows.length === 0 ? (
          <EmptyState icon={BarChart3} title="No launches yet" compact>
            Each cell below shows what one agent found on one day, and which
            keyword it ran on.
          </EmptyState>
        ) : (
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="sticky left-0 z-10 w-64 bg-surface px-5 py-3 text-[11px] font-medium uppercase tracking-wide text-muted"
                  >
                    AI Agent
                  </th>
                  {data.days.map((day) => (
                    <th
                      key={day.iso}
                      scope="col"
                      className="min-w-40 px-3 py-3 text-center text-[11px] font-medium uppercase tracking-wide text-muted"
                    >
                      <span className="block text-foreground">{day.day}</span>
                      <span className="block font-normal">{day.weekday}</span>
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.agentId} className="border-b border-border last:border-0">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-64 bg-surface px-5 py-4 align-top text-left font-normal"
                    >
                      <span className="flex items-center gap-2">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
                          <Target className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        <span className="text-[13px] font-medium">{row.agentName}</span>
                      </span>
                      <span className="mt-1.5 block pl-9">
                        <Pill tone={STATUS_TONE[row.status]} dot>
                          {STATUS_LABEL[row.status]}
                        </Pill>
                      </span>
                    </th>

                    {data.days.map((day) => (
                      <td key={day.iso} className="px-3 py-4 align-top">
                        <DayCell chips={row.cells[day.iso] ?? []} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function DayCell({ chips }: { chips: LaunchChip[] }) {
  if (chips.length === 0) {
    return <span className="block text-center text-muted">—</span>;
  }

  // Productive launches first: a cell of zeroes tells the user nothing, and a
  // cell where the one launch that worked is buried tells them less.
  const ordered = [...chips].sort((a, b) => b.count - a.count);
  const shown = ordered.slice(0, CHIPS_SHOWN);
  const hidden = ordered.length - shown.length;

  return (
    <div className="space-y-1.5">
      {shown.map((chip, i) => (
        <div
          key={`${chip.query}-${i}`}
          className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${
            chip.count > 0
              ? "border-accent-ring bg-accent-soft"
              : "border-border bg-surface"
          }`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-foreground">
              {chip.query}
            </span>
            <span className="block truncate text-muted">{chip.label}</span>
          </span>
          <span
            className={`shrink-0 tabular-nums ${
              chip.count > 0 ? "font-medium text-accent" : "text-muted"
            }`}
          >
            {chip.count}
          </span>
        </div>
      ))}

      {hidden > 0 && (
        <p className="px-2 text-[11px] text-muted">
          + {hidden} more launch{hidden === 1 ? "" : "es"}
        </p>
      )}
    </div>
  );
}
