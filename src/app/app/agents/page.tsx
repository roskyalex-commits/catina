import Link from "next/link";
import { ChevronRight, Mail, Plus, Workflow } from "lucide-react";
import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Pill,
  relativeTime,
} from "@/components/ui/primitives";
import { listAgents } from "@/lib/data/agents";
import type { AgentStatus } from "@/lib/data/types";

export const STATUS_TONE = {
  active: "success",
  paused: "warning",
  draft: "neutral",
} as const;

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
};

export default async function AgentsPage() {
  const agents = await listAgents();

  return (
    <>
      <PageHeader
        icon={Workflow}
        title="Agents"
        description="Each agent owns one targeting profile, its own schedule and its own mailbox."
        action={
          <LinkButton href="/onboarding" variant="primary">
            <Plus className="h-4 w-4" aria-hidden />
            New agent
          </LinkButton>
        }
      />

      {agents.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No agents yet"
          action={
            <LinkButton href="/onboarding" variant="primary">
              Create your first agent
            </LinkButton>
          }
        >
          Paste your website and one gets built from what you sell — targeting,
          keywords and CAEN codes included.
        </EmptyState>
      ) : (
        <ul className="grid gap-3">
          {agents.map((agent) => (
            <li key={agent.id}>
              <Link href={`/app/agents/${agent.id}`} className="block">
                <Card className="flex flex-wrap items-center gap-4 p-4 transition hover:border-border-strong">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
                    <Workflow className="h-5 w-5" aria-hidden />
                  </span>

                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{agent.name}</span>
                      <Pill tone={STATUS_TONE[agent.status]} dot>
                        {STATUS_LABEL[agent.status]}
                      </Pill>
                    </div>
                    <p className="mt-0.5 text-[13px] text-muted">
                      {agent.countries.join(" · ")}
                      {agent.nextLaunchAt
                        ? ` · Next launch ~ ${relativeTime(agent.nextLaunchAt)}`
                        : " · No launch scheduled"}
                    </p>
                  </div>

                  <div className="flex items-center gap-6 text-[13px]">
                    <span>
                      <span className="block text-lg font-semibold tabular-nums leading-none">
                        {agent.leadsFound}
                      </span>
                      <span className="text-muted">found</span>
                    </span>
                    <span>
                      <span className="block text-lg font-semibold tabular-nums leading-none">
                        {agent.contacted}
                      </span>
                      <span className="text-muted">contacted</span>
                    </span>
                  </div>

                  <span className="flex items-center gap-1.5 text-[13px] text-muted">
                    <Mail className="h-4 w-4" aria-hidden />
                    {agent.mailbox?.address ?? "No mailbox"}
                  </span>

                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
