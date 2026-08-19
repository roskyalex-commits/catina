import { notFound } from "next/navigation";
import { AlertTriangle, Clock, Inbox } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  relativeTime,
} from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";

/**
 * The send queue: everything drafted and waiting on the user.
 *
 * Nothing here sends itself on the Free plan. The compliance warning is per
 * message rather than per campaign because a single campaign can span markets
 * with opposite rules — Romania needs prior consent, the UK does not.
 */
export default async function AgentQueuePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  if (agent.queue.length === 0) {
    return (
      <EmptyState icon={Inbox} title="Nothing queued">
        Messages are drafted only when there is a specific signal to open with.
        No signal, no draft.
      </EmptyState>
    );
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {agent.queue.length} message{agent.queue.length === 1 ? "" : "s"} waiting
          for your approval · {agent.campaign.dailySendLimit}/day cap
        </p>
        <div className="flex gap-2">
          <Button>Reject all</Button>
          <Button variant="primary">Approve all</Button>
        </div>
      </div>

      <ul className="grid gap-3">
        {agent.queue.map((message) => (
          <li key={message.id}>
            <Card className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">
                    {message.contactName}{" "}
                    <span className="font-normal text-muted">
                      · {message.companyName}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    Why now: {message.reason}
                  </p>
                </div>
                <span className="flex items-center gap-1.5 text-xs text-muted">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Scheduled {relativeTime(message.scheduledFor)}
                </span>
              </div>

              <div className="mt-3 rounded-[var(--radius-control)] border border-border bg-background p-3">
                <p className="text-[13px] font-medium">{message.subject}</p>
                <p className="mt-1 text-[13px] text-muted">{message.preview}</p>
              </div>

              {message.complianceWarning && (
                <p className="mt-3 flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-soft px-3 py-2 text-[13px] text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {message.complianceWarning}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary">Approve &amp; send</Button>
                <Button>Edit</Button>
                <Button variant="ghost">Skip</Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
