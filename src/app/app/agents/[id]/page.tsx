import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Clock, Info, MessageSquare, X } from "lucide-react";
import { ActivityFeed } from "@/components/agents/activity-feed";
import { AreaChart } from "@/components/charts/area-chart";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";

export default async function AgentOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  const base = `/app/agents/${agent.id}`;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0">
        {agent.pendingReview && (
          <>
            <h2 className="mb-2 text-[15px] font-semibold">Actions</h2>
            <Card className="mb-6 flex flex-wrap items-center gap-3 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
                <MessageSquare className="h-[18px] w-[18px]" aria-hidden />
              </span>
              <div className="min-w-48 flex-1">
                <p className="text-[13px] font-medium">
                  {agent.pendingReview.count} leads will be contacted today
                </p>
                <p className="text-[13px] text-muted">
                  Review their profiles and messages before they go out
                </p>
              </div>
              <Link
                href={`${base}/queue`}
                className="flex items-center gap-1 text-[13px] text-accent"
              >
                Review leads
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
              <button
                type="button"
                aria-label="Dismiss"
                className="rounded-md p-1 text-muted transition hover:bg-background hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </Card>
          </>
        )}

        <SectionTitle
          title="Performance"
          description="From leads found to interested replies"
        />

        <div className="mb-4 mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <BigStat label="Found" value={agent.stats.found} />
          <BigStat label="Contacted" value={agent.stats.contacted} />
          <BigStat
            label="Replied"
            value={agent.stats.replied}
            note="0% reply rate"
            icon={Info}
            title="Reply tracking needs Gmail read access — a restricted scope."
          />
          <BigStat
            label="Interested"
            value={agent.stats.interested}
            icon={Clock}
            title="Set once a reply is classified. Needs reply tracking."
          />
        </div>

        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SmallStat label="Emails sent" value={agent.sendStats.emailsSent} />
          <SmallStat label="Bounces" value={agent.sendStats.bounces} />
          <SmallStat label="Unsubscribes" value={agent.sendStats.unsubscribes} />
          <SmallStat
            label="Deliverable"
            value={
              agent.sendStats.deliverablePct === null
                ? null
                : `${agent.sendStats.deliverablePct}%`
            }
            title="Share of leads with a verified or provider-confirmed address. Replaces open rate, which would need a tracking pixel in the recipient's mail."
          />
        </div>

        <Card className="p-5">
          <div className="mb-4">
            <SectionTitle title="Last 7 days" />
          </div>
          <AreaChart data={agent.chart} height={220} />
        </Card>
      </div>

      <aside className="min-w-0">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Activity Feed</h2>
          <Link
            href={`${base}/activity`}
            className="flex items-center gap-1 text-[13px] text-accent"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>

        {agent.activity.length ? (
          <Card className="scrollbar-thin max-h-[640px] overflow-y-auto p-2">
            <ActivityFeed events={agent.activity} />
          </Card>
        ) : (
          <EmptyState icon={Clock} title="Nothing yet" compact>
            Every launch, send and signal is recorded here.
          </EmptyState>
        )}
      </aside>
    </div>
  );
}

function BigStat({
  label,
  value,
  note,
  icon: Icon,
  title,
}: {
  label: string;
  value: number;
  note?: string;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
}) {
  return (
    <Card className="p-4" title={title}>
      <p className="flex items-center gap-1.5 text-[13px] text-muted">
        {label}
        {Icon && <Icon className="h-3.5 w-3.5" />}
      </p>
      <p className="mt-1 text-[28px] font-semibold leading-none tabular-nums">
        {value}
      </p>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </Card>
  );
}

function SmallStat({
  label,
  value,
  title,
}: {
  label: string;
  value: number | string | null;
  title?: string;
}) {
  return (
    <Card
      className="flex items-center justify-between gap-3 px-4 py-2.5"
      title={title}
    >
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[13px] font-medium tabular-nums">
        {/*
          Only null is a dash. A measured zero is a real answer and often the
          one that matters most — nought bounces is the number you want after a
          send, and showing it as "—" reads as "we never checked". Same
          distinction the send stats draw deliberately: `bounces` is null until
          mail has actually gone out, then it is a count.
        */}
        {value === null ? (
          <span className="text-border-strong">—</span>
        ) : (
          value
        )}
      </span>
    </Card>
  );
}
