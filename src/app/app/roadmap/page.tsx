import { Lightbulb } from "lucide-react";
import { Card, PageHeader, Pill } from "@/components/ui/primitives";

const ITEMS: { title: string; note: string; state: "building" | "next" | "blocked" }[] = [
  { title: "Persisted agents and real sourcing runs", note: "Auth, org bootstrap and the first registry-backed launch.", state: "building" },
  { title: "ONRC bulk import", note: "Streamed from data.gov.ro, filtered to active VAT-registered companies.", state: "next" },
  { title: "Gmail OAuth", note: "gmail.send + gmail.compose — sensitive scopes, no CASA audit.", state: "next" },
  { title: "Scheduled launches", note: "Cloudflare Cron and Queues, once a manual run is known-good.", state: "next" },
  { title: "Reply tracking and Inbox", note: "Needs Gmail's restricted scope and an annual CASA assessment.", state: "blocked" },
  { title: "LinkedIn signals", note: "No lawful free source. Would need a paid API.", state: "blocked" },
];

const TONE = { building: "accent", next: "info", blocked: "warning" } as const;
const LABEL = { building: "Building", next: "Next", blocked: "Blocked" } as const;

export default function RoadmapPage() {
  return (
    <>
      <PageHeader
        icon={Lightbulb}
        title="Roadmap & Ideas"
        description="What is being built, and what is deliberately not."
      />
      <ul className="grid max-w-3xl gap-3">
        {ITEMS.map((item) => (
          <li key={item.title}>
            <Card className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{item.title}</p>
                <p className="mt-0.5 text-[13px] text-muted">{item.note}</p>
              </div>
              <Pill tone={TONE[item.state]}>{LABEL[item.state]}</Pill>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
