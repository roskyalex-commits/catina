import { notFound } from "next/navigation";
import { AlertTriangle, Check, ShieldCheck } from "lucide-react";
import { Card, Pill, SectionTitle } from "@/components/ui/primitives";
import { getAgent } from "@/lib/data/agents";
import { jurisdictionFor } from "@/lib/outreach/compliance";
import { CONSERVATIVE_DAILY_LIMIT } from "@/lib/outreach/gmail";

export default async function AgentCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) notFound();

  // Only the markets this agent actually targets — a compliance table listing
  // twenty countries the user never contacts is noise they will learn to skip.
  const jurisdictions = agent.sources.countries.map(jurisdictionFor);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Card className="p-5">
          <SectionTitle title="Sending" />
          <dl className="mt-4 divide-y divide-border text-[13px]">
            <Row label="Sender">
              {agent.campaign.senderEmail ?? (
                <span className="text-muted">No mailbox connected</span>
              )}
            </Row>
            <Row label="Auto-send">
              {agent.campaign.autoSend ? (
                <Pill tone="warning" dot>
                  On
                </Pill>
              ) : (
                <span>
                  Off — every message waits for approval{" "}
                  <span className="text-muted">(Free plan)</span>
                </span>
              )}
            </Row>
            <Row label="Daily cap">
              {agent.campaign.dailySendLimit} per mailbox
            </Row>
            <Row label="Romania acknowledgement">
              {agent.campaign.complianceAcknowledged ? (
                <Pill tone="success" dot>
                  Acknowledged
                </Pill>
              ) : (
                <Pill tone="warning" dot>
                  Required before sending
                </Pill>
              )}
            </Row>
          </dl>
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Sequence"
            description="Guidance for the drafter, not a mail-merge template."
          />
          <ol className="mt-4 space-y-3">
            {agent.campaign.steps.map((step) => (
              <li key={step.stepIndex} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-medium text-accent">
                  {step.stepIndex + 1}
                </span>
                <div>
                  <p className="text-[13px]">{step.instruction}</p>
                  <p className="text-xs text-muted">
                    {step.delayDays === 0
                      ? "Sent first"
                      : `${step.delayDays} days later`}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="p-5">
          <SectionTitle title="What happens before anything sends" />
          <ul className="mt-4 space-y-2">
            {[
              `A hard cap of ${CONSERVATIVE_DAILY_LIMIT} messages per mailbox per day, spread across working hours with jitter.`,
              "Suppression is re-checked at send time, not when the message was queued — an unsubscribe that lands in between is still honoured.",
              "A draft containing an unfilled placeholder is discarded rather than sent.",
              "Every message carries a one-click unsubscribe header, sender identity, and a GDPR Article 14 note saying where the details came from.",
              "Messages are only drafted when there is a specific signal to open with. No signal, no send.",
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-[13px]">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                <span className="text-muted">{line}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card className="h-fit p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted" aria-hidden />
          <SectionTitle title="Rules by market" />
        </div>
        <p className="mt-2 text-[13px] text-muted">
          &ldquo;GDPR compliance&rdquo; is not one rule. Whether you may send an
          unsolicited commercial email is set by each country&rsquo;s ePrivacy
          implementation, and those differ sharply.
        </p>

        <div className="mt-4 space-y-3">
          {jurisdictions.map((rule) => {
            const strict = rule.posture === "consent_required";
            return (
              <div
                key={rule.country}
                className="rounded-[var(--radius-control)] border border-border p-3"
              >
                <p className="flex items-center gap-2 text-[13px] font-medium">
                  {rule.countryName}
                  {strict && (
                    <span className="flex items-center gap-1 text-danger">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                      Strict
                    </span>
                  )}
                </p>
                <p className="mt-1 text-[13px] text-muted">{rule.summary}</p>
                <p className="mt-1 text-xs text-muted">{rule.statute}</p>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs text-muted">
          Romania is the strict case and this product&rsquo;s home market: Law
          506/2004 has no B2B exemption, and ANSPDCP fines run RON 5,000–100,000
          or up to 2% of turnover. Sending stays your decision — only the
          do-not-contact list blocks outright. This is a summary, not legal
          advice.
        </p>
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
