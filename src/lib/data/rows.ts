import type { ScoreBreakdown } from "@/lib/signals/scoring";
import {
  NEGATIVE_SIGNALS,
  recencyMultiplier,
  type Signal,
} from "@/lib/signals/types";
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
 * The chip under a lead's name.
 *
 * A **buying signal** when the company has one, and the sourcing provenance
 * only when it does not.
 *
 * That order is the whole point of the column, and it used to be the other way
 * round by omission: this read `source_label`/`source_query` and nothing else,
 * so every row said "Matched CAEN 6201" — the code the lead was *found* by —
 * while "Runs WooCommerce today" sat one click away in the score breakdown.
 * A column named SIGNAL showing an industry code is the exact complaint the
 * signals work exists to answer.
 *
 * Provenance is kept as the fallback rather than dropped. "Matched CAEN 6201"
 * is a poor signal but an honest answer to "why is this person on my list",
 * and 855 of 919 leads have no signal yet.
 */
function contactSignal(
  row: Record<string, unknown>,
  signals: readonly Signal[] = [],
): ContactSignal | null {
  const strongest = strongestSignal(signals);
  if (strongest) {
    return {
      title: strongest.title,
      evidenceUrl: strongest.evidenceUrl,
      kind: "signal",
    };
  }

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
 * The one signal worth showing in a single line.
 *
 * Decayed strength, not raw: a nine-month-old funding round should not outrank
 * a competitor detected last week, and `recencyMultiplier` is the same
 * half-life curve the score itself uses — so the chip and the number can never
 * disagree about which signal mattered most.
 *
 * Distress signals are excluded. They are real and they belong in the
 * breakdown, but a row whose headline reads "Insolvency proceedings on record"
 * is not a lead the user is being invited to act on.
 */
function strongestSignal(signals: readonly Signal[]): Signal | undefined {
  const now = new Date();
  return [...signals]
    .filter((signal) => !NEGATIVE_SIGNALS.has(signal.type))
    .sort(
      (a, b) =>
        b.strength * recencyMultiplier(b.type, b.detectedAt, now) -
        a.strength * recencyMultiplier(a.type, a.detectedAt, now),
    )[0];
}

/**
 * Map a joined lead row.
 *
 * Absent data stays absent: a lead with no email yet gets `null`, not a
 * fabricated address. About 1% of registry companies carry a domain, so this is
 * the common case rather than an edge one, and the UI is built to show it.
 */
export function contactRowFrom(
  row: Record<string, unknown>,
  signals: readonly Signal[] = [],
): ContactRow {
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
    signal: contactSignal(row, signals),
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
          isRoleAddress: email?.is_role_address === true,
        }
      : null,
    /*
     * ANAF does publish phone numbers, and has been returning them since the
     * first import — `AnafCompany.phone` was parsed and then dropped for want
     * of a column. 98.2% of companies now carry one.
     *
     * Worth stating because the comment that used to sit here said the opposite
     * and the UI repeated it to the user: a stale assumption about a source is
     * indistinguishable from a fact until someone checks.
     */
    phone: optionalString(company?.phone) ?? null,
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
