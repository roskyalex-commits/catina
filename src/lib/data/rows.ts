import type { ScoreBreakdown } from "@/lib/signals/scoring";
import {
  optionalDate,
  optionalNumber,
  optionalString,
  requireString,
} from "@/lib/supabase/row";
import { flamesFor } from "./score";
import type {
  ActivityEvent,
  ContactRow,
  ContactSignal,
  EmailStatus,
  FitFeedback,
  SourceLabel,
} from "./types";

/**
 * PostgREST rows → the view models the screens read.
 *
 * Every accessor in this directory selects the same joined shape, so the
 * mapping lives here once. Pure, so it can be tested without a database —
 * which matters more than usual because the generated `Database` type is still
 * a placeholder and every column arrives as `unknown`.
 *
 * The join is `leads → people, companies`. PostgREST returns an embedded object
 * for a to-one relationship, but types it as an array in some versions, so
 * `embedded()` below tolerates both rather than crashing on whichever arrives.
 */

/** Unwrap a PostgREST embedded relation, which may be an object or an array. */
export function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    return (value[0] as Record<string, unknown>) ?? null;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

const SOURCE_LABELS: SourceLabel[] = ["keyword", "lookalike", "autopilot", "signal"];
const EMAIL_STATUSES: EmailStatus[] = [
  "pattern",
  "found",
  "verified",
  "risky",
  "invalid",
  "bounced",
];
const FIT_VALUES: FitFeedback[] = ["good", "unsure", "bad"];

function sourceLabel(value: unknown): SourceLabel {
  const found = SOURCE_LABELS.find((label) => label === optionalString(value));
  return found ?? "autopilot";
}

/**
 * The chip under a lead's name, explaining why it was sourced.
 *
 * Built from what the sourcing run recorded rather than re-derived: the run
 * knew whether a CAEN code or a keyword matched, and re-deciding here could
 * disagree with the row's own `source_label`.
 */
function contactSignal(row: Record<string, unknown>): ContactSignal | null {
  const query = optionalString(row.source_query);
  const kind = sourceLabel(row.source_label);

  if (!query && kind === "autopilot") {
    return {
      title: "Matched your targeting",
      kind,
    };
  }
  if (!query) return null;

  return {
    title: kind === "keyword" ? `Matched ${query}` : query,
    query,
    kind,
  };
}

/**
 * Map a joined lead row.
 *
 * Absent data stays absent: a lead with no email yet gets `null`, not a
 * fabricated address. About 1% of registry companies carry a domain, so this is
 * the common case rather than an edge one, and the UI is built to show it.
 */
export function contactRowFrom(row: Record<string, unknown>): ContactRow {
  const person = embedded(row.people);
  const company = embedded(row.companies);
  const email = embedded(row.emails);
  const list = embedded(row.lists);

  const score = optionalNumber(row.score) ?? 0;
  const emailAddress = optionalString(email?.address);

  return {
    id: requireString(row.id, "id"),
    fullName: optionalString(person?.full_name) ?? "Unknown contact",
    title: optionalString(person?.title),
    companyName: optionalString(company?.name) ?? "Unknown company",
    companyDomain: optionalString(company?.domain),
    country: optionalString(company?.country),
    county: optionalString(company?.county),
    caen: optionalString(company?.caen),
    signal: contactSignal(row),
    score,
    flames: flamesFor(score),
    // The breakdown is written by the scoring engine as jsonb and read back
    // verbatim; the drawer renders whatever reasons the run recorded.
    breakdown: (row.score_breakdown ?? {
      total: score,
      icpFit: { score: 0, weight: 0, reasons: [] },
      signals: { score: 0, weight: 0, reasons: [] },
      contactability: { score: 0, weight: 0, reasons: [] },
      penalties: { total: 0, reasons: [] },
    }) as ScoreBreakdown,
    email: emailAddress
      ? {
          address: emailAddress,
          status:
            EMAIL_STATUSES.find((status) => status === optionalString(email?.status)) ??
            "pattern",
          confidence: optionalNumber(email?.confidence) ?? 0,
        }
      : null,
    phone: optionalString(company?.phone),
    importedAt: optionalDate(row.created_at) ?? new Date(0),
    list: list
      ? {
          id: requireString(list.id, "list.id"),
          name: optionalString(list.name) ?? "List",
        }
      : null,
    fitFeedback:
      FIT_VALUES.find((value) => value === optionalString(row.fit_feedback)) ?? null,
    agentId: optionalString(row.agent_id) ?? "",
  };
}

const ACTIVITY_KINDS: ActivityEvent["kind"][] = [
  "leads_found",
  "no_leads",
  "email_sent",
  "signal",
  "launch",
  "error",
];

/** Initials for the avatar chip, from a Romanian "Surname Given" name. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("ro-RO") ?? "")
    .join("");
}

/**
 * Map a `job_runs` row to a feed event.
 *
 * A run that found nothing is still an event — "no new leads found" tells the
 * user the agent ran, which silence does not.
 */
export function activityEventFrom(row: Record<string, unknown>): ActivityEvent {
  const found = optionalNumber(row.leads_found) ?? 0;
  const failed = optionalString(row.status) === "failed";

  const kind: ActivityEvent["kind"] = failed
    ? "error"
    : found > 0
      ? "leads_found"
      : "no_leads";

  return {
    id: requireString(row.id, "id"),
    title:
      optionalString(row.title) ??
      (found > 0 ? `${found} new leads found` : "No new leads found"),
    subtitle: optionalString(row.subtitle),
    kind: ACTIVITY_KINDS.includes(kind) ? kind : "launch",
    at: optionalDate(row.created_at) ?? new Date(0),
  };
}
