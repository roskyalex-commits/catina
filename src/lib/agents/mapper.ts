import {
  optionalDate,
  optionalNumber,
  optionalString,
  requireString,
  stringArray,
} from "@/lib/supabase/row";
import type {
  AgentDetail,
  AgentStatus,
  AgentSummary,
  ChartData,
} from "@/lib/data/types";
import type { CreateAgentInput } from "./schema";

/**
 * Between the `agents` table and the view models in `lib/data/types`.
 *
 * Pure functions on plain objects, deliberately: no database has ever existed
 * for this project (see docs/STATUS.md), so the mapping is the part that can
 * actually be tested today. The route handler stays thin enough that what is
 * left untested there is one PostgREST call.
 *
 * Rows arrive from PostgREST with snake_case keys and `unknown` values — the
 * generated `Database` type is still a placeholder — so every field goes
 * through the narrowing helpers in `lib/supabase/row.ts` rather than a cast.
 */

const DAY = 86_400_000;
const CHART_DAYS = 7;
const AGENT_STATUSES: AgentStatus[] = ["draft", "active", "paused"];

/** Row shape for an insert. Snake_case because PostgREST takes column names. */
export type AgentInsert = Record<string, unknown>;

/**
 * Build the insert payload.
 *
 * `org_id` comes from the caller's membership, never from the request body —
 * accepting it from the client would let anyone write into another tenant, and
 * RLS is the second line of defence here, not the first.
 *
 * `status` is always `draft`: an agent becomes active when it is launched,
 * which needs a mailbox and a compliance acknowledgement that this route does
 * not collect.
 */
export function agentInsertFrom(
  input: CreateAgentInput,
  orgId: string,
): AgentInsert {
  return {
    org_id: orgId,
    name: input.name,
    website_url: input.websiteUrl,
    value_prop: input.valueProp,
    product_name: input.productName ?? null,
    target_titles: input.targetTitles,
    target_seniorities: input.targetSeniorities,
    industries: input.industries,
    caen_codes: input.caenCodes,
    countries: input.countries,
    keywords: input.keywords,
    exclusions: input.exclusions,
    employee_min: input.employeeMin,
    employee_max: input.employeeMax,
    // numeric columns: PostgREST takes a number and returns a string.
    revenue_min_ron: input.revenueMinRon,
    revenue_max_ron: input.revenueMaxRon,
    company_types: input.companyTypes,
    enabled_signals: input.enabledSignals,
    // Display-only, so it stays jsonb. Assumptions are the half of the
    // analysis the user most needs to see again later.
    source_evidence: { assumptions: input.assumptions },
    confidence: input.confidence,
    status: "draft" satisfies AgentStatus,
  };
}

function statusFrom(value: unknown): AgentStatus {
  const status = optionalString(value);
  return AGENT_STATUSES.find((candidate) => candidate === status) ?? "draft";
}

/** Counts that live in other tables. Zero until the sourcing run writes rows. */
export type AgentCounts = { leadsFound: number; contacted: number };

export const NO_COUNTS: AgentCounts = { leadsFound: 0, contacted: 0 };

export function agentSummaryFrom(
  row: Record<string, unknown>,
  counts: AgentCounts = NO_COUNTS,
): AgentSummary {
  return {
    id: requireString(row.id, "id"),
    name: requireString(row.name, "name"),
    status: statusFrom(row.status),
    createdAt: optionalDate(row.created_at) ?? new Date(0),
    nextLaunchAt: optionalDate(row.next_launch_at),
    // Needs a join on `email_accounts`, which no agent can reference until
    // Gmail OAuth exists (step 6). Null is the honest answer, not a stub.
    mailbox: null,
    leadsFound: counts.leadsFound,
    contacted: counts.contacted,
    countries: stringArray(row.countries),
  };
}

/**
 * Seven zeroed days, labelled like the demo chart so the chart component and
 * its axis code are exercised identically whether or not data exists. A real
 * agent with no runs yet should show a flat line, not an empty box.
 */
export function emptyChart(now: Date = new Date()): ChartData {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  const labels = Array.from({ length: CHART_DAYS }, (_, i) => {
    const day = new Date(midnight.getTime() - (CHART_DAYS - 1 - i) * DAY);
    return day.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
  });
  const zeros = () => Array.from({ length: CHART_DAYS }, () => 0);

  return {
    labels,
    series: [
      { key: "leads", label: "Leads found", color: "--series-leads", points: zeros() },
      { key: "companies", label: "Companies sourced", color: "--series-invites", points: zeros() },
      { key: "signals", label: "Signals detected", color: "--series-messages", points: zeros() },
      { key: "emails", label: "Emails sent", color: "--series-emails", points: zeros() },
    ],
  };
}

/**
 * The detail view for an agent that exists but has never run.
 *
 * Every count is zero and every list is empty — not because the data is
 * missing, but because it genuinely is zero until step 4 sources anything.
 * `deliverablePct` and `bounces` stay null: nothing has been measured, and
 * reporting 0% deliverability would be a claim about mail that never left.
 */
export function agentDetailFrom(
  row: Record<string, unknown>,
  counts: AgentCounts = NO_COUNTS,
  now: Date = new Date(),
): AgentDetail {
  return {
    ...agentSummaryFrom(row, counts),
    stats: {
      found: counts.leadsFound,
      contacted: counts.contacted,
      replied: 0,
      interested: 0,
    },
    sendStats: {
      emailsSent: 0,
      bounces: null,
      unsubscribes: 0,
      deliverablePct: null,
    },
    chart: emptyChart(now),
    activity: [],
    queue: [],
    leads: [],
    sources: {
      keywords: stringArray(row.keywords),
      caenCodes: stringArray(row.caen_codes),
      countries: stringArray(row.countries),
      targetTitles: stringArray(row.target_titles),
      enabledSignals: stringArray(row.enabled_signals),
    },
    campaign: {
      autoSend: false,
      // Free-tier default. Reads from `plans` once billing is wired.
      dailySendLimit: 20,
      senderEmail: null,
      complianceAcknowledged: false,
      steps: [],
    },
    pendingReview: null,
  };
}

/** Exported for the detail page's revenue band, which reads numerics. */
export function revenueBandFrom(row: Record<string, unknown>) {
  return {
    minRon: optionalNumber(row.revenue_min_ron),
    maxRon: optionalNumber(row.revenue_max_ron),
  };
}
