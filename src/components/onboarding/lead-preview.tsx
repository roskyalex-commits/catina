"use client";

import { useState } from "react";
import { Building2, Check, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/primitives";
import { industriesForCode, industryByKey, naceLabel } from "@/lib/icp/industries";
import {
  applyRefinement,
  refineIcpFromRejections,
  type RejectedLead,
  type Refinement,
} from "@/lib/icp/refine";
import type { Icp } from "@/lib/icp/schema";
import { cn } from "@/lib/utils";

/**
 * Onboarding step 4 — five real leads, and what rejecting them teaches.
 *
 * These are rows the sourcing run actually created against a draft agent, not
 * a mock: the same query, the same scoring, the same evidence. Showing invented
 * cards here would make the one screen whose entire job is "does this look like
 * your customers" the one screen that cannot answer it.
 *
 * Rejections do two things, and the separation matters. They PATCH the lead so
 * `fit_feedback` records the verdict — explicit training data, and the only
 * kind that distinguishes "wrong" from "not yet". And they feed
 * `refineIcpFromRejections`, which is deterministic and offline: a chip appears
 * with the count that produced it, and the user accepts or dismisses it. The
 * ICP is never rewritten by anything but a click.
 */

export type PreviewLead = {
  id: string;
  companyName: string;
  personName: string | null;
  title: string | null;
  score: number;
  caen: string | null;
  employeeCount: number | null;
  city: string | null;
  signals: { title: string; evidenceUrl?: string }[];
  email: string | null;
};

export function LeadPreview({
  icp,
  leads,
  loading,
  error,
  onIcpChange,
  onReject,
  onRerun,
}: {
  icp: Icp;
  leads: PreviewLead[];
  loading: boolean;
  error: string | null;
  onIcpChange: (next: Icp) => void;
  /** Records the verdict server-side. Failure here must not block the UI. */
  onReject: (leadId: string) => void;
  onRerun: () => void;
}) {
  const [rejected, setRejected] = useState<RejectedLead[]>([]);
  const [rejectedIds, setRejectedIds] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const suggestions = refineIcpFromRejections(icp, rejected).filter(
    (refinement) => !dismissed.includes(refinementId(refinement)),
  );

  function reject(lead: PreviewLead) {
    if (rejectedIds.includes(lead.id)) return;
    setRejectedIds((prev) => [...prev, lead.id]);
    setRejected((prev) => [
      ...prev,
      {
        companyName: lead.companyName,
        caen: lead.caen,
        employeeCount: lead.employeeCount,
      },
    ]);
    onReject(lead.id);
  }

  function accept(refinement: Refinement) {
    onIcpChange(applyRefinement(icp, refinement));
    setDismissed((prev) => [...prev, refinementId(refinement)]);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-[-0.01em]">
          Do these look like your customers?
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          Five real leads from the query you just built. Reject the wrong ones —
          the ICP learns from the pattern, not from any single miss.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}

      {loading && (
        <p className="text-[13px] text-muted">Sourcing five leads…</p>
      )}

      {!loading && !error && leads.length === 0 && (
        <div className="rounded-[var(--radius-control)] border border-border p-4 text-[13px]">
          <p className="font-medium">Nothing matched.</p>
          <p className="mt-1 text-muted">
            The filters are narrower than the data. Widening the industries, or
            clearing the employee and revenue bands, is usually what does it —
            only {icp.caenCodes.length} activity codes are in play.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {leads.map((lead) => {
          const isRejected = rejectedIds.includes(lead.id);
          const industry = lead.caen ? industriesForCode(lead.caen)[0] : undefined;

          return (
            <li
              key={lead.id}
              className={cn(
                "rounded-[var(--radius-control)] border p-4 transition",
                isRejected ? "border-border bg-background opacity-50" : "border-border",
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                    <Building2 className="h-3.5 w-3.5 text-muted" aria-hidden />
                    {lead.companyName}
                    <span className="rounded-full bg-background px-2 py-0.5 text-[11px] text-muted">
                      {lead.score}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {lead.personName ?? "No decision-maker on file"}
                    {lead.title ? ` · ${lead.title}` : ""}
                    {lead.city ? ` · ${lead.city}` : ""}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {industry ? industryByKey(industry)?.label : null}
                    {lead.caen ? (
                      <>
                        {industry ? " · " : ""}
                        <span className="font-mono">{lead.caen}</span>{" "}
                        {naceLabel(lead.caen) ?? ""}
                      </>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted">
                    {lead.email ?? "No address found yet"}
                  </p>

                  {lead.signals.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {lead.signals.map((signal) => (
                        <li key={signal.title} className="text-[12px]">
                          {signal.evidenceUrl ? (
                            <a
                              href={signal.evidenceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-accent underline underline-offset-2"
                            >
                              {signal.title}
                            </a>
                          ) : (
                            <span className="text-muted">{signal.title}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Button
                  onClick={() => reject(lead)}
                  disabled={isRejected}
                  aria-label={`Reject ${lead.companyName}`}
                >
                  {isRejected ? (
                    <>
                      <Check className="h-4 w-4" aria-hidden />
                      Rejected
                    </>
                  ) : (
                    <>
                      <X className="h-4 w-4" aria-hidden />
                      Not a fit
                    </>
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {rejected.length > 0 && suggestions.length === 0 && (
        <p className="text-[13px] text-muted">
          {rejected.length === 1 || rejected.length === 2
            ? `Noted. Two more rejections and we can look for a pattern.`
            : `Noted — but these rejections have nothing in common, so there is nothing to change. Adjust the targeting yourself if this is the wrong list.`}
        </p>
      )}

      {suggestions.length > 0 && (
        <section className="rounded-[var(--radius-control)] border border-border p-4">
          <h2 className="text-[13px] font-medium">Want us to change the targeting?</h2>
          <ul className="mt-3 space-y-2">
            {suggestions.map((refinement) => (
              <li
                key={refinementId(refinement)}
                className="flex flex-wrap items-start justify-between gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{refinement.label}</span>
                  <span className="block text-[12px] text-muted">
                    {refinement.reason}
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button variant="primary" onClick={() => accept(refinement)}>
                    Apply
                  </Button>
                  <Button
                    onClick={() =>
                      setDismissed((prev) => [...prev, refinementId(refinement)])
                    }
                  >
                    No
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Button onClick={onRerun} disabled={loading}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        Show me five more
      </Button>
    </div>
  );
}

/** Stable across re-renders so dismissing one chip does not dismiss another. */
function refinementId(refinement: Refinement): string {
  switch (refinement.kind) {
    case "drop_industry":
      return `drop_industry:${refinement.industryKey}`;
    case "add_exclusion":
      return `add_exclusion:${refinement.term}`;
    case "narrow_employees":
      return `narrow_employees:${refinement.min}:${refinement.max}`;
  }
}
