import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateCompliance } from "@/lib/outreach/compliance";
import { optionalDate, optionalString } from "@/lib/supabase/row";
import { embedded } from "./rows";
import type { QueuedMessage } from "./types";

/**
 * The send queue: drafted messages, and the campaign they belong to.
 *
 * Read through the caller's own client so RLS decides what comes back —
 * `messages` and `campaigns` are both org-scoped tenant tables. Nothing here
 * touches `email_accounts`, which is service-role only and has its own
 * accessor.
 *
 * ## Which states count as "queued"
 *
 * `drafted`, `approved` and `in_gmail_drafts`. The third is the interesting
 * one: with auto-send off, a message that reached Gmail is *not* done — it is
 * sitting in the user's Drafts folder waiting for them to press send. Dropping
 * it from this screen would make the default posture look like a black hole.
 * `sent`, `skipped` and `failed` are finished and belong in the activity feed.
 */

const QUEUE_STATES = ["drafted", "approved", "in_gmail_drafts"] as const;

/** One literal — supabase-js reads it at the type level. */
const QUEUE_COLUMNS =
  "id, state, subject, body, scheduled_for, created_at, signals(title), leads(people(full_name), companies(name, country), emails(address, is_role_address))";

export type CampaignSettings = {
  id: string;
  autoSend: boolean;
  dailySendLimit: number;
  senderEmail: string | null;
  complianceAcknowledged: boolean;
  status: string;
};

export async function campaignForAgent(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string,
): Promise<CampaignSettings | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, status, auto_send, daily_send_limit, sender_email, compliance_ack_at")
    .eq("org_id", orgId)
    .eq("agent_id", agentId)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("Reading the campaign failed:", error.message);
    return null;
  }
  if (!data) return null;

  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    autoSend: row.auto_send === true,
    dailySendLimit: Number(row.daily_send_limit ?? 30),
    senderEmail: optionalString(row.sender_email),
    complianceAcknowledged: optionalString(row.compliance_ack_at) !== null,
    status: optionalString(row.status) ?? "draft",
  };
}

export async function queueForCampaign(
  supabase: SupabaseClient,
  campaign: CampaignSettings,
  limit = 50,
): Promise<QueuedMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(QUEUE_COLUMNS)
    .eq("campaign_id", campaign.id)
    .in("state", QUEUE_STATES as unknown as string[])
    .order("scheduled_for", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("Reading the queue failed:", error.message);
    return [];
  }

  return (data ?? []).map((row) =>
    queuedMessageFrom(row as Record<string, unknown>, campaign),
  );
}

export function queuedMessageFrom(
  row: Record<string, unknown>,
  campaign: CampaignSettings,
): QueuedMessage {
  const lead = embedded(row.leads);
  const person = embedded(lead?.people);
  const company = embedded(lead?.companies);
  const email = embedded(lead?.emails);
  const signal = embedded(row.signals);

  const body = optionalString(row.body) ?? "";

  /*
   * Evaluated per message rather than per campaign, because one campaign can
   * span markets with opposite rules — Romania requires prior consent, the UK
   * does not — and a single banner at the top of the screen would be wrong for
   * half the list either way.
   */
  const verdict = evaluateCompliance({
    recipientCountry: optionalString(company?.country),
    recipientEmail: optionalString(email?.address) ?? "",
    isRoleAddress: email?.is_role_address === true,
    autoSend: campaign.autoSend,
    complianceAcknowledged: campaign.complianceAcknowledged,
  });

  const warning = verdict.issues.find((issue) => issue.severity !== "info");

  return {
    id: String(row.id),
    contactName: optionalString(person?.full_name) ?? "Unknown contact",
    companyName: optionalString(company?.name) ?? "Unknown company",
    subject: optionalString(row.subject) ?? "(no subject)",
    // First paragraph, not a character count: the opening line is the whole
    // claim of this product, so it is the part worth showing without a click.
    preview: firstParagraph(body),
    reason: optionalString(signal?.title) ?? "Matched your targeting",
    scheduledFor:
      optionalDate(row.scheduled_for) ?? optionalDate(row.created_at) ?? new Date(),
    complianceWarning: warning?.message ?? null,
  };
}

function firstParagraph(body: string): string {
  const paragraph = body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return paragraph.length > 220 ? `${paragraph.slice(0, 217)}…` : paragraph;
}
