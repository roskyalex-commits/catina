import { notFound } from "next/navigation";
import { Inbox } from "lucide-react";
import { QueueList } from "@/components/agents/queue";
import { EmptyState } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";

export const dynamic = "force-dynamic";

/**
 * The send queue: everything drafted and waiting on the user.
 *
 * Nothing sends itself unless the campaign says to. The compliance warning is
 * per message rather than per campaign because a single campaign can span
 * markets with opposite rules — Romania needs prior consent, the UK does not.
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
        No signal, no draft. Run{" "}
        <code className="font-mono">npm run outreach:draft -- --agent {id}</code>{" "}
        to fill this.
      </EmptyState>
    );
  }

  return (
    <>
      <p className="mb-4 text-[13px] text-muted">
        {agent.campaign.dailySendLimit}/day cap ·{" "}
        {agent.campaign.senderEmail ?? "no mailbox connected"}
      </p>
      <QueueList messages={agent.queue} />
    </>
  );
}
