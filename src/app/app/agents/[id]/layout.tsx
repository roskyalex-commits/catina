import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Info, Mail, Pause, Pencil, Play, Target } from "lucide-react";
import { AgentTabs } from "@/components/agents/tabs";
import { Button, Pill, relativeTime } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";
import { STATUS_LABEL, STATUS_TONE } from "../page";

/**
 * Agent chrome: identity, status, mailbox and the tab bar.
 *
 * Lives in a layout so it stays mounted across tab navigation — switching from
 * Overview to Leads should not re-render the header or lose scroll position.
 */
export default async function AgentLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  const base = `/app/agents/${agent.id}`;
  const paused = agent.status !== "active";

  return (
    <>
      <Link
        href="/app/agents"
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted transition hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        All agents
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Target className="h-[18px] w-[18px] text-accent" aria-hidden />
            <h1 className="text-[19px] font-semibold tracking-[-0.01em]">
              {agent.name}
            </h1>
            <button
              type="button"
              aria-label="Rename agent"
              className="rounded-md p-1 text-muted transition hover:bg-background hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
            <Pill tone={STATUS_TONE[agent.status]} dot>
              {STATUS_LABEL[agent.status]}
            </Pill>
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
            <span>Created {relativeTime(agent.createdAt)}</span>
            {agent.nextLaunchAt && (
              <>
                <span>·</span>
                <span>Next launch ~</span>{" "}
                <span className="font-medium text-foreground">
                  {relativeTime(agent.nextLaunchAt)}
                </span>
                <Info className="h-3.5 w-3.5" aria-hidden />
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {agent.mailbox ? (
            <span className="flex items-center gap-2 text-[13px]">
              <Mail className="h-4 w-4 text-muted" aria-hidden />
              {agent.mailbox.address}
              {agent.mailbox.warmingUp && (
                <Pill tone="warning" dot>
                  Ramping up
                </Pill>
              )}
              <Link
                href={`${base}/settings`}
                aria-label="Change mailbox"
                className="rounded-md p-1 text-muted transition hover:bg-background hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </span>
          ) : (
            <Link
              href={`${base}/settings`}
              className="flex items-center gap-2 text-[13px] text-accent"
            >
              <Mail className="h-4 w-4" aria-hidden />
              Connect a mailbox
            </Link>
          )}

          <Button variant="primary">
            {paused ? (
              <>
                <Play className="h-4 w-4" aria-hidden />
                Resume Outreach
              </>
            ) : (
              <>
                <Pause className="h-4 w-4" aria-hidden />
                Pause Outreach
              </>
            )}
          </Button>
        </div>
      </div>

      <AgentTabs
        tabs={[
          { href: base, label: "Overview" },
          { href: `${base}/leads`, label: "Leads", count: agent.leads.length },
          {
            href: `${base}/queue`,
            label: "Queue",
            count: agent.queue.length,
            urgent: true,
          },
          { href: `${base}/sources`, label: "Sources" },
          { href: `${base}/campaign`, label: "Campaign" },
          { href: `${base}/activity`, label: "Activity" },
          { href: `${base}/settings`, label: "Settings" },
        ]}
      />

      <div className="pt-5">{children}</div>
    </>
  );
}
