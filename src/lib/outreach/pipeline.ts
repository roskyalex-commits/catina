import type { SupabaseClient } from "@supabase/supabase-js";
import { NEGATIVE_SIGNALS, recencyMultiplier, type Signal } from "@/lib/signals/types";
import { optionalNumber, optionalString } from "@/lib/supabase/row";
import type { EmailStatus } from "@/lib/data/types";
import { draftLanguageFor, type Draft } from "./draft";

/**
 * Choosing who to write to, and writing the rows that say so.
 *
 * The sending half lives in `send.ts`; this half decides what deserves to be
 * sent at all. Splitting them is deliberate — drafting costs a model call per
 * lead and sending costs the org's reputation, and the two want different
 * failure behaviour. A bad draft is discarded. A bad send cannot be.
 *
 * ## The eligibility rules are the product
 *
 * Four gates, and every one of them exists because skipping it produces mail
 * that should not have left:
 *
 * 1. **A deliverable address.** A `pattern` address is a *guess* the mailbox
 *    never confirmed. Guessing at scale is precisely how a sending domain gets
 *    burned — bounce rate is the single strongest input to whether the next
 *    message lands in a spam folder — so guesses are excluded by default and
 *    `--allow-unverified` exists to make including them an explicit act.
 * 2. **A specific signal.** `draftMessage` requires one and refuses to invent
 *    an opening. A lead with nothing to say is not a lead yet.
 * 3. **Not on the do-not-contact list.** Re-checked at send time too, because
 *    an opt-out can arrive between drafting and sending.
 * 4. **Not already written to.** One message per lead per campaign. A retry, a
 *    double-run, or a re-queue must not produce a second copy in somebody's
 *    inbox.
 *
 * A distress signal disqualifies rather than opens: a company in insolvency is
 * not a prospect, and "I saw you have entered insolvency proceedings" is the
 * worst opening line this system could produce.
 */

/** One literal — supabase-js reads it at the type level. */
export const OUTREACH_LEAD_COLUMNS =
  "id, org_id, agent_id, company_id, person_id, status, score, created_at, people(full_name, first_name, last_name, title), companies(name, domain, country, county), emails(address, status, confidence, is_role_address)";

/**
 * Address statuses that may be mailed without an explicit override.
 *
 * `found` is included because it was read off the company's own website — the
 * address exists in the sense that matters. `verified` was additionally probed.
 * Everything else is a guess, a catch-all non-answer, or a known bad address.
 */
export const SENDABLE_STATUSES: readonly EmailStatus[] = ["verified", "found"];

/** Adds unconfirmed guesses. Costs bounce rate; never the default. */
export const UNVERIFIED_STATUSES: readonly EmailStatus[] = [
  ...SENDABLE_STATUSES,
  "pattern",
];

export type OutreachLead = {
  leadId: string;
  orgId: string;
  agentId: string;
  companyId: string;
  personId: string | null;
  status: string;
  score: number;
  fullName: string;
  firstName: string | null;
  title: string | null;
  companyName: string;
  country: string | null;
  email: {
    address: string;
    status: EmailStatus;
    confidence: number;
    isRoleAddress: boolean;
  } | null;
};

export function outreachLeadFrom(row: Record<string, unknown>): OutreachLead {
  const person = embedded(row.people);
  const company = embedded(row.companies);
  const email = embedded(row.emails);
  const address = optionalString(email?.address);

  return {
    leadId: String(row.id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    companyId: String(row.company_id),
    personId: optionalString(row.person_id),
    status: optionalString(row.status) ?? "new",
    score: optionalNumber(row.score) ?? 0,
    fullName: optionalString(person?.full_name) ?? "",
    firstName: optionalString(person?.first_name),
    title: optionalString(person?.title),
    companyName: optionalString(company?.name) ?? "",
    country: optionalString(company?.country),
    email: address
      ? {
          address,
          status: (optionalString(email?.status) ?? "pattern") as EmailStatus,
          confidence: optionalNumber(email?.confidence) ?? 0,
          isRoleAddress: email?.is_role_address === true,
        }
      : null,
  };
}

function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export type EligibilityContext = {
  signals: readonly Signal[];
  suppressed: boolean;
  alreadyMessaged: boolean;
  allowedStatuses?: readonly EmailStatus[];
  now?: Date;
};

export type Eligibility =
  | { ok: true; signal: Signal }
  | { ok: false; reason: string; code: SkipCode };

export type SkipCode =
  | "no_email"
  | "unverified_email"
  | "no_signal"
  | "distress"
  | "suppressed"
  | "already_messaged"
  | "no_name"
  | "rejected";

/**
 * May we write to this lead, and what would the message open with?
 *
 * Pure, and returns the chosen signal rather than a bare boolean, so the caller
 * cannot pick a different one than the check was made against. The skip codes
 * are counted by the script — a run reporting "drafted 4, skipped 96" is
 * useless without the breakdown, and the breakdown is usually the finding.
 */
export function eligibleForOutreach(
  lead: OutreachLead,
  context: EligibilityContext,
): Eligibility {
  const allowed = context.allowedStatuses ?? SENDABLE_STATUSES;

  if (lead.status === "rejected") {
    return { ok: false, code: "rejected", reason: "Lead was rejected" };
  }
  if (!lead.fullName.trim() || !lead.companyName.trim()) {
    return { ok: false, code: "no_name", reason: "No person or company name" };
  }
  if (!lead.email) {
    return { ok: false, code: "no_email", reason: "No email address" };
  }
  if (!allowed.includes(lead.email.status)) {
    return {
      ok: false,
      code: "unverified_email",
      reason: `Address is "${lead.email.status}", not one of ${allowed.join("/")}`,
    };
  }
  if (context.suppressed) {
    return { ok: false, code: "suppressed", reason: "On the do-not-contact list" };
  }
  if (context.alreadyMessaged) {
    return { ok: false, code: "already_messaged", reason: "Already written to" };
  }

  const signals = context.signals;
  if (signals.length === 0) {
    return { ok: false, code: "no_signal", reason: "No signal to open with" };
  }

  /*
   * A company in distress is disqualified outright rather than falling through
   * to a weaker signal. `scoreLead` already docks it, but a score is a
   * suggestion and this is not: mailing a sales pitch to a company in
   * insolvency proceedings is the failure mode nobody forgives.
   */
  if (signals.some((signal) => NEGATIVE_SIGNALS.has(signal.type))) {
    return {
      ok: false,
      code: "distress",
      reason: "Company shows a distress signal",
    };
  }

  const signal = strongestSignal(signals, context.now ?? new Date());
  if (!signal) {
    return { ok: false, code: "no_signal", reason: "No signal to open with" };
  }
  return { ok: true, signal };
}

/**
 * The signal the message opens with.
 *
 * Decayed strength, the same half-life curve the score uses — so the opening
 * line and the number can never disagree about which fact mattered most.
 */
export function strongestSignal(
  signals: readonly Signal[],
  now: Date = new Date(),
): Signal | undefined {
  return [...signals]
    .filter((signal) => !NEGATIVE_SIGNALS.has(signal.type))
    .sort(
      (a, b) =>
        b.strength * recencyMultiplier(b.type, b.detectedAt, now) -
        a.strength * recencyMultiplier(a.type, a.detectedAt, now),
    )[0];
}

/* ------------------------------------------------------------- persistence */

/**
 * The campaign a message belongs to.
 *
 * `messages.campaign_id` is NOT NULL, and an agent that has never had its
 * campaign screen opened has no row. Created on demand rather than at agent
 * creation, so the table only holds campaigns that actually mean something.
 *
 * Note what the defaults are: `status: "draft"` and `auto_send: false`. A
 * campaign conjured by a drafting run must not thereby become one that sends
 * on its own — `guardSend` blocks on `campaignActive`, and that block is the
 * point.
 */
export async function ensureCampaign(
  admin: SupabaseClient,
  input: { orgId: string; agentId: string; name: string },
): Promise<{ id: string; autoSend: boolean; dailyLimit: number; status: string } | null> {
  const { data: existing, error: readError } = await admin
    .from("campaigns")
    .select("id, auto_send, daily_send_limit, status")
    .eq("org_id", input.orgId)
    .eq("agent_id", input.agentId)
    .limit(1)
    .maybeSingle();

  if (readError) {
    console.error("Reading the campaign failed:", readError.message);
    return null;
  }
  if (existing) {
    const row = existing as Record<string, unknown>;
    return {
      id: String(row.id),
      autoSend: row.auto_send === true,
      dailyLimit: optionalNumber(row.daily_send_limit) ?? 30,
      status: optionalString(row.status) ?? "draft",
    };
  }

  const { data, error } = await admin
    .from("campaigns")
    .insert({
      org_id: input.orgId,
      agent_id: input.agentId,
      name: input.name,
      status: "draft",
      auto_send: false,
    })
    .select("id, auto_send, daily_send_limit, status")
    .maybeSingle();

  if (error || !data) {
    console.error("Creating the campaign failed:", error?.message);
    return null;
  }
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    autoSend: false,
    dailyLimit: optionalNumber(row.daily_send_limit) ?? 30,
    status: optionalString(row.status) ?? "draft",
  };
}

/**
 * Which of these leads already has a message.
 *
 * Chunked, because `in` with two thousand ids is a URL PostgREST will refuse,
 * and paged past the silent 1,000-row cap for the same reason every other
 * batched read here is.
 */
export async function alreadyMessaged(
  admin: SupabaseClient,
  campaignId: string,
  leadIds: readonly string[],
): Promise<Set<string>> {
  const seen = new Set<string>();
  const ids = [...new Set(leadIds)];

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await admin
      .from("messages")
      .select("lead_id")
      .eq("campaign_id", campaignId)
      .in("lead_id", chunk);

    if (error) {
      // Fail closed: treating an unreadable table as "nobody has been written
      // to" is how a whole campaign gets sent twice.
      console.error("Checking for existing messages failed:", error.message);
      for (const id of chunk) seen.add(id);
      continue;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const leadId = optionalString(row.lead_id);
      if (leadId) seen.add(leadId);
    }
  }
  return seen;
}

/**
 * Signal row ids, keyed by dedupe key.
 *
 * `Signal` carries `dedupeKey` and not `id`, because everything downstream of a
 * scan works in dedupe keys — but `messages.signal_id` is a foreign key, and
 * without it the queue screen cannot say *why* a message exists. One batched
 * read closes that gap; `signals_dedupe_idx` is unique, so the mapping is
 * one-to-one.
 */
export async function signalIdsByKey(
  admin: SupabaseClient,
  dedupeKeys: readonly string[],
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  const keys = [...new Set(dedupeKeys)].filter(Boolean);

  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await admin
      .from("signals")
      .select("id, dedupe_key")
      .in("dedupe_key", keys.slice(i, i + 200));

    if (error) {
      // Not fatal: a message with a null `signal_id` still sends, it just
      // cannot link back to its evidence.
      console.error("Resolving signal ids failed:", error.message);
      continue;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const key = optionalString(row.dedupe_key);
      if (key) byKey.set(key, String(row.id));
    }
  }
  return byKey;
}

export type QueuedDraft = {
  lead: OutreachLead;
  draft: Draft;
  signalId: string | null;
  scheduledFor: Date;
};

/**
 * Write the drafts as `messages` rows in state `drafted`.
 *
 * `drafted` and not `approved`: nothing here decides to send. The queue screen
 * or `outreach:send --approve` does that, and keeping the two apart is what
 * makes it possible to look at a hundred generated messages before any of them
 * exists outside this database.
 */
export async function queueDrafts(
  admin: SupabaseClient,
  input: { orgId: string; campaignId: string; drafts: readonly QueuedDraft[] },
): Promise<{ written: number; error?: string }> {
  if (input.drafts.length === 0) return { written: 0 };

  const rows = input.drafts.map((item) => ({
    org_id: input.orgId,
    campaign_id: input.campaignId,
    lead_id: item.lead.leadId,
    channel: "email",
    language: item.draft.language,
    subject: item.draft.subject,
    body: item.draft.body,
    signal_id: item.signalId,
    state: "drafted",
    scheduled_for: item.scheduledFor.toISOString(),
  }));

  const { error } = await admin.from("messages").insert(rows);
  if (error) return { written: 0, error: `Writing the drafts failed: ${error.message}` };
  return { written: rows.length };
}

/** Romanian recipients get Romanian copy. Re-exported so callers need one import. */
export { draftLanguageFor };
