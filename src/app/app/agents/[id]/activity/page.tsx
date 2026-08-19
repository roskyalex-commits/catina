import { notFound } from "next/navigation";
import { Clock } from "lucide-react";
import { ActivityFeed } from "@/components/agents/activity-feed";
import { Card, EmptyState } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";

export default async function AgentActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  if (agent.activity.length === 0) {
    return (
      <EmptyState icon={Clock} title="No activity yet">
        Every launch, send, signal and failure is recorded here, including the
        launches that found nothing.
      </EmptyState>
    );
  }

  return (
    <Card className="max-w-2xl p-2">
      <ActivityFeed events={agent.activity} />
    </Card>
  );
}
