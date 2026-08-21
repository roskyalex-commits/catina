import type { SupabaseClient } from "@supabase/supabase-js";
import { optionalString } from "@/lib/supabase/row";
import { GmailClient, GmailError } from "./gmail";
import type { BuildMessageInput, DisclosureContent } from "./mime";
import { guardSend, type SendBlockCode } from "./send-guard";
import { isSuppressed } from "./suppressions";

/**
 * The send runner: the last twenty metres, where a mistake is not recoverable.
 *
 * Everything before this point writes rows. This talks to Gmail, and a message
 * that leaves cannot be unsent, deleted, or explained. The structure follows
 * from that:
 *
 * - **Nothing is inferred here.** Every input — mailbox, campaign posture,
 *   sender identity — is passed in by the caller, so this file has no way to
 *   quietly send from the wrong account or in the wrong mode.
 * - **The database is written *before* success is assumed and again after.**
 *   If Gmail accepts a message and the update then fails, the run stops rather
 *   than continuing, because the alternative is re-sending it on the next run.
 * - **Suppression is re-read per message**, not per run. The re-check is the
 *   whole reason `guardSend` takes `suppressed` as an argument instead of
 *   looking it up itself, and passing the batch value would defeat it.
 *
 * ## Draft mode is the default and it is not a lesser mode
 *
 * With `autoSend` off, each message becomes a real draft in the user's own
 * Gmail. They open Gmail, read it, edit it, press send. That is a complete
 * product: it removes the writing and the research, and leaves the judgement
 * with the person whose name is on the message.
 */

/** One literal — supabase-js reads it at the type level. */
export const DUE_MESSAGE_COLUMNS =
  "id, org_id, campaign_id, lead_id, subject, body, language, state, scheduled_for, leads(id, status, people(full_name), companies(name, country), emails(address, status, is_role_address))";

export type DueMessage = {
  id: string;
  leadId: string;
  subject: string;
  body: string;
  recipientName: string;
  recipientEmail: string;
  recipientCountry: string | null;
  isRoleAddress: boolean;
};

export function dueMessageFrom(row: Record<string, unknown>): DueMessage | null {
  const lead = embedded(row.leads);
  const person = embedded(lead?.people);
  const company = embedded(lead?.companies);
  const email = embedded(lead?.emails);
  const address = optionalString(email?.address);

  // A message whose lead lost its address between drafting and sending has
  // nowhere to go. Returning null keeps that out of the send loop entirely
  // rather than failing an address check further in.
  if (!address) return null;

  return {
    id: String(row.id),
    leadId: String(row.lead_id),
    subject: optionalString(row.subject) ?? "",
    body: optionalString(row.body) ?? "",
    recipientName: optionalString(person?.full_name) ?? "",
    recipientEmail: address,
    recipientCountry: optionalString(company?.country),
    isRoleAddress: email?.is_role_address === true,
  };
}

function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export type SenderIdentity = DisclosureContent & { email: string };

export type SendContext = {
  admin: SupabaseClient;
  orgId: string;
  /** Null in a dry run — nothing is talked to. */
  gmail: GmailClient | null;
  sender: SenderIdentity;
  campaign: {
    id: string;
    autoSend: boolean;
    active: boolean;
    dailyLimit: number;
    complianceAcknowledged: boolean;
  };
  /** Sends already made today, from `sentToday`. Incremented as the run goes. */
  sentToday: number;
  /** Base URL for the unsubscribe link. */
  appUrl: string;
  dryRun?: boolean;
};

export type SendOutcome =
  | { message: DueMessage; state: "sent"; gmailId: string }
  | { message: DueMessage; state: "in_gmail_drafts"; gmailId: string }
  | { message: DueMessage; state: "skipped"; reason: string; code: SendBlockCode }
  | { message: DueMessage; state: "deferred"; reason: string; code: SendBlockCode }
  | { message: DueMessage; state: "failed"; reason: string }
  | { message: DueMessage; state: "would_send"; reason: string };

/**
 * The unsubscribe URL for one message.
 *
 * Keyed by message id, which is a v4 UUID — 122 bits of randomness, so it is
 * not guessable, and it identifies the recipient without putting their address
 * in a URL that will end up in somebody's server logs.
 */
export function unsubscribeUrlFor(appUrl: string, messageId: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/v1/unsubscribe?m=${messageId}`;
}

/**
 * Send or draft one message.
 *
 * Three ways this ends and they are genuinely different, which is why they are
 * not collapsed into a boolean:
 *
 * - **skipped** — permanently. Suppressed, duplicate, unsendable address. The
 *   row is closed out so no future run reconsiders it.
 * - **deferred** — the block is temporary (daily cap, paused campaign). The row
 *   is left alone so tomorrow's run picks it up. Marking these `skipped` would
 *   silently drop a campaign the moment it hit its own daily limit.
 * - **failed** — Gmail refused. Recorded with the reason, because "sending
 *   failed" without one is unactionable.
 */
export async function sendOne(
  context: SendContext,
  message: DueMessage,
): Promise<SendOutcome> {
  // Fresh, per message. See the note at the top of the file.
  const suppressed = await isSuppressed(
    context.admin,
    context.orgId,
    message.recipientEmail,
  );

  const decision = guardSend({
    recipientEmail: message.recipientEmail,
    recipientCountry: message.recipientCountry,
    isRoleAddress: message.isRoleAddress,
    suppressed,
    autoSend: context.campaign.autoSend,
    complianceAcknowledged: context.campaign.complianceAcknowledged,
    sentToday: context.sentToday,
    dailyLimit: context.campaign.dailyLimit,
    // The `messages` row is the duplicate check — one per lead per campaign is
    // enforced when drafting, and re-sending an already-sent row is what this
    // guards against.
    alreadySentToLead: false,
    campaignActive: context.campaign.active,
  });

  if (!decision.allowed) {
    const state = decision.retryable ? "deferred" : "skipped";
    if (state === "skipped") {
      await closeOut(context.admin, message.id, "skipped", decision.reason);
    }
    return { message, state, reason: decision.reason, code: decision.code };
  }

  const payload: BuildMessageInput = {
    from: { name: context.sender.senderName, email: context.sender.email },
    to: { name: message.recipientName || undefined, email: message.recipientEmail },
    subject: message.subject,
    body: message.body,
    unsubscribeUrl: unsubscribeUrlFor(context.appUrl, message.id),
    disclosures: context.sender,
    // Whatever this recipient's jurisdiction requires — the verdict decides,
    // not a global template. Romania needs more than the UK does.
    required: decision.verdict.requiredDisclosures,
  };

  if (context.dryRun || !context.gmail) {
    return {
      message,
      state: "would_send",
      reason: context.campaign.autoSend ? "would send" : "would create a Gmail draft",
    };
  }

  /*
   * The Gmail call is the only thing inside this try, and that boundary is
   * load-bearing. Wrapping the write below in it too would catch
   * `recordDelivery`'s throw and mark the message `failed` — after Gmail had
   * already accepted it. The row would then read as a failure that never
   * happened, and be a candidate for a retry that sends it twice.
   */
  let result;
  try {
    result = context.campaign.autoSend
      ? await context.gmail.send(payload)
      : await context.gmail.createDraft(payload);
  } catch (error) {
    const reason =
      error instanceof GmailError ? error.message : `Sending failed: ${describe(error)}`;

    /*
     * A rate limit is not a failure of this message — it is a statement about
     * the next few minutes. Recording it as `failed` would retire a perfectly
     * good message permanently, so it defers instead and the caller stops the
     * run.
     */
    if (error instanceof GmailError && (error.status === 429 || error.status === 403)) {
      return { message, state: "deferred", reason, code: "daily_limit" };
    }

    await closeOut(context.admin, message.id, "failed", reason);
    return { message, state: "failed", reason };
  }

  const state = context.campaign.autoSend ? "sent" : "in_gmail_drafts";
  await recordDelivery(context.admin, {
    messageId: message.id,
    leadId: message.leadId,
    state,
    gmailId: result.messageId,
    threadId: result.threadId,
  });

  return { message, state, gmailId: result.messageId };
}

/**
 * Record a delivery: the message row, then the lead.
 *
 * The message row goes first and its failure is fatal to the run. If Gmail has
 * accepted a message and we cannot record that, the next run would send it
 * again — and a duplicate cold email is the one mistake a recipient
 * unambiguously notices.
 *
 * The lead's own status is best-effort by comparison: it drives a UI count, and
 * a wrong count is worth strictly less than a second copy of the message.
 */
async function recordDelivery(
  admin: SupabaseClient,
  input: {
    messageId: string;
    leadId: string;
    state: "sent" | "in_gmail_drafts";
    gmailId: string;
    threadId?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("messages")
    .update({
      state: input.state,
      ...(input.state === "sent"
        ? { gmail_message_id: input.gmailId, sent_at: now }
        : { gmail_draft_id: input.gmailId }),
      gmail_thread_id: input.threadId ?? null,
      updated_at: now,
    })
    .eq("id", input.messageId);

  if (error) {
    throw new Error(
      `Gmail accepted the message but recording it failed: ${error.message}. ` +
        "Stopping so the next run does not send it a second time.",
    );
  }

  const { error: leadError } = await admin
    .from("leads")
    .update({
      status: input.state === "sent" ? "sent" : "queued",
      updated_at: now,
    })
    .eq("id", input.leadId);

  if (leadError) console.error("Updating the lead status failed:", leadError.message);
}

async function closeOut(
  admin: SupabaseClient,
  messageId: string,
  state: "skipped" | "failed",
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("messages")
    .update({ state, failure_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", messageId);
  if (error) console.error(`Marking the message ${state} failed:`, error.message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
