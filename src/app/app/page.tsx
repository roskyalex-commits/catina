import Link from "next/link";
import {
  ArrowRight,
  MessageSquare,
  Radar,
  Rocket,
  UserRound,
  Zap,
} from "lucide-react";
import { AreaChart } from "@/components/charts/area-chart";
import {
  Avatar,
  Card,
  EmptyState,
  Flames,
  LinkButton,
  Pill,
  SectionTitle,
  relativeTime,
} from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { StatTile } from "@/components/ui/stat";
import { getDashboard } from "@/lib/data/dashboard";
import { RANGE_LABELS } from "@/lib/data/types";
import type { RangeKey } from "@/lib/data/types";

const RANGE_OPTIONS = (Object.keys(RANGE_LABELS) as RangeKey[]).map((value) => ({
  value,
  label: RANGE_LABELS[value],
}));

function parseRange(value: string | undefined): RangeKey {
  return value && value in RANGE_LABELS ? (value as RangeKey) : "30d";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const range = parseRange((await searchParams).range);
  const data = await getDashboard(range);
  const rangeLabel = RANGE_LABELS[range];

  return (
    <>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Welcome {data.greetingName} <span aria-hidden>🚀</span>
        </h1>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="neutral" className="ring-1 ring-border">
            <Radar className="h-3.5 w-3.5" aria-hidden />
            {data.activeSignals} Active Signal{data.activeSignals === 1 ? "" : "s"}
          </Pill>
          {!data.mailboxConnected && (
            <LinkButton href="/app/settings" variant="secondary" className="border-accent-ring text-accent">
              Connect Gmail
            </LinkButton>
          )}
        </div>
      </div>

      <div className="mb-5 flex justify-end">
        <Segmented param="range" value={range} options={RANGE_OPTIONS} />
      </div>

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile
          className="lg:col-span-2"
          icon={Zap}
          label="Next actions"
          value={data.nextActions.pendingTasks}
          hint={
            data.nextActions.nextLaunchAt ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                Next launch ~ {relativeTime(data.nextActions.nextLaunchAt)}
              </span>
            ) : (
              "No launch scheduled"
            )
          }
          footer={
            <>
              <span className="flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5" aria-hidden />
                {data.nextActions.companiesSourced} companies
              </span>
              <span className="flex items-center gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                {data.nextActions.messagesDrafted} drafts
              </span>
            </>
          }
        />

        <StatTile
          label="Hot Opportunities"
          value={data.hotOpportunities}
          hint={`Scoring 70+ · ${rangeLabel}`}
        />

        <StatTile
          label="Leads Engaged"
          value={data.leadsEngaged}
          hint={`Emails sent · ${rangeLabel}`}
        />

        <StatTile
          label="Conversations"
          value={
            data.conversations === 0 ? (
              <span className="text-border-strong">—</span>
            ) : (
              data.conversations
            )
          }
          hint={
            <>
              Replies need Gmail read access, a restricted scope.{" "}
              <Link href="/app/inbox" className="text-accent underline underline-offset-2">
                Why
              </Link>
            </>
          }
        />

        <StatTile
          label="Pipeline generated"
          value={
            data.pipeline.valueEur === null ? (
              <span className="text-border-strong">—</span>
            ) : (
              `€${data.pipeline.valueEur.toLocaleString("en")}`
            )
          }
          action={
            <button type="button" className="text-[13px] text-accent">
              Edit
            </button>
          }
          hint={
            data.pipeline.dealSizeSet
              ? `From ${data.hotOpportunities} qualified opportunities`
              : "Set deal size to see pipeline generated"
          }
        />
      </div>

      <Card className="mb-5 p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <SectionTitle
            title="Activity Overview"
            description="Track your lead generation and outreach performance"
          />
        </div>
        {data.chart.labels.length ? (
          <AreaChart data={data.chart} height={260} />
        ) : (
          <EmptyState icon={Radar} title="Nothing plotted yet" compact>
            The chart fills in from the first agent launch.
          </EmptyState>
        )}
      </Card>

      {/*
        `[&>*]:min-w-0` — a grid item defaults to `min-width: auto`, so it
        refuses to shrink below its content's min-content width. The inner rows
        already `truncate`, but that never gets a chance to apply: the track
        resolves wider than the container and the card pushes the page into a
        horizontal scroll on a phone. Letting the items shrink is what lets the
        truncation do its job.
      */}
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <Card className="p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
              <UserRound className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <SectionTitle
              title="Latest Hot Leads"
              description="Your most promising prospects"
            />
            <Link
              href="/app/contacts"
              className="ml-auto flex shrink-0 items-center gap-1 text-[13px] text-accent"
            >
              View More
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </div>

          {data.hotLeads.length ? (
            <ul className="divide-y divide-border">
              {data.hotLeads.map((lead) => (
                <li key={lead.id} className="flex items-center gap-3 py-3">
                  <Avatar name={lead.fullName} size={36} />
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/app/contacts?q=${encodeURIComponent(lead.fullName)}`}
                      className="block truncate text-[13px] font-medium text-info hover:underline"
                    >
                      {lead.fullName}
                    </Link>
                    <p className="truncate text-[13px] text-muted">
                      {lead.title} @ {lead.companyName}
                    </p>
                  </div>
                  <Flames count={lead.flames} score={lead.score} />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Rocket} title="No leads yet" compact>
              Launch an agent and the highest-scoring people land here.
            </EmptyState>
          )}
        </Card>

        <Card className="p-5">
          <div className="mb-4 flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-info-soft text-info">
              <MessageSquare className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <SectionTitle
              title="Latest Replies"
              description="Recent conversation responses"
            />
          </div>

          <EmptyState icon={MessageSquare} title="No replies tracked" compact>
            Reading a mailbox needs Gmail&rsquo;s restricted scope and a CASA
            audit. Sending does not, so outreach works today — replies land in
            your own inbox until that is in place.
          </EmptyState>
        </Card>
      </div>
    </>
  );
}
