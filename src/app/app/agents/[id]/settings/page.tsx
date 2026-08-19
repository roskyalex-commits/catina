import { notFound } from "next/navigation";
import { Mail, Trash2 } from "lucide-react";
import { Button, Card, Pill, SectionTitle } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";
import { STATUS_LABEL, STATUS_TONE } from "../../page";

export default async function AgentSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  return (
    <div className="grid max-w-3xl gap-5">
      <Card className="p-5">
        <SectionTitle title="Agent" />
        <dl className="mt-4 divide-y divide-border text-[13px]">
          <Row label="Name">{agent.name}</Row>
          <Row label="Status">
            <Pill tone={STATUS_TONE[agent.status]} dot>
              {STATUS_LABEL[agent.status]}
            </Pill>
          </Row>
          <Row label="Created">
            {agent.createdAt.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </Row>
          <Row label="Markets">{agent.countries.join(", ")}</Row>
        </dl>
      </Card>

      <Card className="p-5">
        <SectionTitle
          title="Mailbox"
          description="Only gmail.send and gmail.compose are requested — both sensitive scopes, so no CASA audit is required."
        />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Mail className="h-4 w-4 text-muted" aria-hidden />
          {agent.mailbox ? (
            <>
              <span className="text-[13px]">{agent.mailbox.address}</span>
              {agent.mailbox.warmingUp && (
                <Pill tone="warning" dot>
                  Ramping up
                </Pill>
              )}
              <Button className="ml-auto">Disconnect</Button>
            </>
          ) : (
            <>
              <span className="text-[13px] text-muted">
                No mailbox connected — nothing can send.
              </span>
              <Button variant="primary" className="ml-auto">
                Connect Gmail
              </Button>
            </>
          )}
        </div>
      </Card>

      <Card className="border-danger-soft p-5">
        <SectionTitle
          title="Delete agent"
          description="Removes the agent and its leads. Sourced companies stay — they are shared reference data."
        />
        <div className="mt-4">
          <Button className="border-danger-soft text-danger">
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete this agent
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-2">{children}</dd>
    </div>
  );
}
