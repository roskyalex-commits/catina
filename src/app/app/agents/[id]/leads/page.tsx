import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { ContactsTable } from "@/components/contacts/table";
import { EmptyState } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";

export default async function AgentLeadsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  if (agent.leads.length === 0) {
    return (
      <EmptyState icon={Users} title="No leads found yet">
        This agent has not completed a launch. Everything it finds shows up
        here, scored, before anything is sent.
      </EmptyState>
    );
  }

  return <ContactsTable rows={agent.leads} />;
}
