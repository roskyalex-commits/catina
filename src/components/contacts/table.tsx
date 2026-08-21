"use client";

import { useMemo, useState } from "react";
import {
  AtSign,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  HelpCircle,
  Loader2,
  X,
} from "lucide-react";
import {
  useContactEnrichment,
  WithContactEnrichment,
  type EnrichState,
} from "@/components/contacts/enrichment";
import { ScoreExplanation } from "@/components/leads/score-badge";
import { Avatar, Flames, relativeTime } from "@/components/ui/primitives";
import type { ContactRow, FitFeedback } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * The contacts table.
 *
 * Eleven columns is a lot, and every one earns its place: the reference product
 * puts enrichment and list assignment inline because the alternative is opening
 * a drawer per row for a hundred rows. Two departures from it:
 *
 * - SIGNAL links to the filing or job posting behind the claim. Theirs is
 *   LinkedIn activity with nowhere to click through to.
 * - The row expands in place rather than opening a drawer, so the score
 *   breakdown can be compared against the row above it.
 */
/**
 * Self-sufficient: it supplies the enrichment context when nothing above it
 * has. See `WithContactEnrichment` for why.
 */
export function ContactsTable({ rows }: { rows: ContactRow[] }) {
  return (
    <WithContactEnrichment>
      <ContactsTableBody rows={rows} />
    </WithContactEnrichment>
  );
}

function ContactsTableBody({ rows }: { rows: ContactRow[] }) {
  // Selection lives in the provider so the toolbar's bulk Enrich button can see
  // it; without that it had nothing to act on and did nothing.
  const { selected, toggle, toggleAll, results, enrich } = useContactEnrichment();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FitFeedback | null>>({});

  const allSelected = rows.length > 0 && selected.size === rows.length;

  const fitFor = useMemo(
    () => (row: ContactRow) =>
      row.id in feedback ? feedback[row.id] : row.fitFeedback,
    [feedback],
  );

  return (
    <div className="scrollbar-thin overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
      <table className="w-full min-w-[1320px] border-collapse text-left">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
            <th scope="col" className="w-10 px-3 py-3">
              <input
                type="checkbox"
                aria-label="Select all contacts"
                checked={allSelected}
                onChange={() => toggleAll(rows.map((r) => r.id))}
                className="h-4 w-4 accent-[var(--accent)]"
              />
            </th>
            <th scope="col" className="px-3 py-3 font-medium">Contact</th>
            <th scope="col" className="w-64 px-3 py-3 font-medium">Signal</th>
            <th scope="col" className="px-3 py-3 font-medium">AI Score</th>
            <th scope="col" className="px-3 py-3 font-medium">Email</th>
            <th scope="col" className="px-3 py-3 font-medium">Phone</th>
            <th scope="col" className="px-3 py-3 font-medium">Imported</th>
            <th scope="col" className="px-3 py-3 font-medium">List</th>
            <th scope="col" className="px-3 py-3 font-medium">Fit</th>
            {/*
              `relative` so the `sr-only` label below resolves against this
              cell. Absolutely positioned with no positioned ancestor it
              resolved against the document instead, landing past the right
              edge and making the whole page scroll sideways — the table's own
              overflow container was working correctly and never saw it.
            */}
            <th scope="col" className="relative w-10 px-3 py-3">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const open = expanded === row.id;
            const fit = fitFor(row);

            return (
              <tr key={row.id} className="border-b border-border last:border-0 align-top">
                <td className="px-3 py-4">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.fullName}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </td>

                <td className="px-3 py-4">
                  <div className="flex items-start gap-3">
                    <Avatar name={row.fullName} size={36} />
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-info">
                        {row.fullName}
                      </p>
                      <p className="truncate text-[13px] text-muted">{row.title}</p>
                      <p className="flex items-center gap-1 truncate text-[13px] text-muted">
                        <Building2 className="h-3 w-3 shrink-0" aria-hidden />
                        {row.companyName}
                      </p>
                    </div>
                  </div>
                </td>

                <td className="w-64 px-3 py-4 text-[13px]">
                  {row.signal ? (
                    <>
                      {row.signal.evidenceUrl ? (
                        <a
                          href={row.signal.evidenceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-start gap-1 text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
                        >
                          {row.signal.title}
                          <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                        </a>
                      ) : (
                        <span>{row.signal.title}</span>
                      )}
                      {row.signal.query && (
                        <p className="mt-0.5 text-muted">
                          Keyword: <span className="font-medium">{row.signal.query}</span>
                        </p>
                      )}
                    </>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                <td className="px-3 py-4">
                  <Flames count={row.flames} score={row.score} />
                </td>

                <td className="px-3 py-4 text-[13px]">
                  <EmailCell row={row} state={results[row.id]} onEnrich={() => enrich([row.id])} />
                </td>

                <td className="whitespace-nowrap px-3 py-4 text-[13px] text-muted">
                  {/*
                    Still no Enrich control, but for a different reason than the
                    one that used to be written here. That comment said the
                    trade register does not publish phone numbers; ANAF does,
                    and 98.2% of companies now carry one from the ordinary
                    registry pass. Nothing is left to enrich on demand.
                  */}
                  {row.phone ?? (
                    <span title="ANAF has no phone number on file for this company">—</span>
                  )}
                </td>

                <td className="whitespace-nowrap px-3 py-4 text-[13px] text-muted">
                  {relativeTime(row.importedAt)}
                </td>

                <td className="px-3 py-4 text-[13px]">
                  {row.list ? (
                    <span className="text-info">{row.list.name}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>

                <td className="whitespace-nowrap px-3 py-4">
                  <FitControl
                    value={fit ?? null}
                    onChange={(next) =>
                      setFeedback((prev) => ({
                        ...prev,
                        [row.id]: prev[row.id] === next ? null : next,
                      }))
                    }
                    name={row.fullName}
                  />
                </td>

                <td className="px-3 py-4">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : row.id)}
                    aria-expanded={open}
                    aria-label={`${open ? "Hide" : "Show"} score breakdown for ${row.fullName}`}
                    className="rounded-md p-1 text-muted transition hover:bg-background hover:text-foreground"
                  >
                    {open ? (
                      <ChevronDown className="h-4 w-4" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    )}
                  </button>
                </td>
              </tr>
            );
          })}

          {rows.flatMap((row) =>
            expanded === row.id
              ? [
                  <tr key={`${row.id}-detail`} className="border-b border-border bg-background">
                    <td colSpan={10} className="px-3 py-4">
                      <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                        <div>
                          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                            How this score was reached
                          </p>
                          <ScoreExplanation breakdown={row.breakdown} />
                        </div>
                        <dl className="grid h-fit grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                          <Detail label="Company" value={row.companyName} />
                          <Detail label="Domain" value={row.companyDomain} />
                          <Detail label="Country" value={row.country} />
                          <Detail label="County" value={row.county} />
                          <Detail label="CAEN" value={row.caen} />
                          <Detail
                            label="Email confidence"
                            value={
                              row.email
                                ? `${Math.round(row.email.confidence * 100)}%`
                                : null
                            }
                          />
                        </dl>
                      </div>
                    </td>
                  </tr>,
                ]
              : [],
          )}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5">{value ?? "—"}</dd>
    </div>
  );
}

/**
 * The email cell: an address, or the button that goes looking for one.
 *
 * Three things are shown rather than one, because a blank cell is the least
 * useful answer available. A found address gets its status pill; a role address
 * is labelled as such, since `office@` reaches the company rather than the
 * person and that changes how the message should be written; and a miss reports
 * *why*, because "no website on file" and "this domain accepts no mail" call
 * for different things from the user.
 *
 * `state` is the just-returned result, `row.email` is what the server rendered.
 * The former wins while it exists so the cell updates without waiting for the
 * refresh that follows it.
 */
function EmailCell({
  row,
  state,
  onEnrich,
}: {
  row: ContactRow;
  state: EnrichState | undefined;
  onEnrich: () => void;
}) {
  if (state?.phase === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Searching…
      </span>
    );
  }

  const resolved = state?.phase === "done" && state.email ? state.email : row.email;

  if (resolved) {
    return (
      <span className="flex flex-col gap-0.5">
        <span className="whitespace-nowrap">{resolved.address}</span>
        <span className="flex items-center gap-1">
          <span
            className={cn(
              "w-fit rounded px-1.5 py-0.5 text-[11px]",
              resolved.status === "verified"
                ? "bg-success-soft text-success"
                : resolved.status === "found"
                  ? "bg-info-soft text-info"
                  : "bg-warning-soft text-warning",
            )}
          >
            {resolved.status}
          </span>
          {resolved.isRoleAddress && (
            <span className="text-[11px] text-muted">role address</span>
          )}
        </span>
      </span>
    );
  }

  if (state?.phase === "done" || state?.phase === "error") {
    return (
      <span className="flex flex-col items-start gap-1">
        <span className="text-[12px] text-muted">{state.note}</span>
        <EnrichButton icon={AtSign} label="Try again" onClick={onEnrich} />
      </span>
    );
  }

  return <EnrichButton icon={AtSign} label="Enrich" onClick={onEnrich} />;
}

function EnrichButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-[12px] text-muted transition hover:bg-accent-soft hover:text-accent"
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

/**
 * The user's verdict on a lead.
 *
 * Three states rather than a thumbs up/down, because "not sure" is the honest
 * answer for most rows and collapsing it into "bad" would poison the training
 * signal this column exists to collect.
 */
function FitControl({
  value,
  onChange,
  name,
}: {
  value: FitFeedback | null;
  onChange: (next: FitFeedback) => void;
  name: string;
}) {
  const options: {
    key: FitFeedback;
    icon: typeof Check;
    label: string;
    on: string;
  }[] = [
    { key: "good", icon: Check, label: "Good fit", on: "bg-success-soft text-success" },
    { key: "unsure", icon: HelpCircle, label: "Not sure", on: "bg-background text-muted-strong" },
    { key: "bad", icon: X, label: "Bad fit", on: "bg-danger-soft text-danger" },
  ];

  return (
    <span className="flex items-center gap-1">
      {options.map((option) => {
        const Icon = option.icon;
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            aria-label={`${option.label}: ${name}`}
            title={option.label}
            onClick={() => onChange(option.key)}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-full transition",
              active
                ? option.on
                : "bg-background text-border-strong hover:text-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </button>
        );
      })}
    </span>
  );
}
