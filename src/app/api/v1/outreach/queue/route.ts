import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv, isDatabaseConfigured } from "@/lib/env";
import { CONSERVATIVE_DAILY_LIMIT, GmailClient } from "@/lib/outreach/gmail";
import {
  MailboxError,
  accessTokenFor,
  findMailbox,
  recordSend,
  sentToday,
} from "@/lib/outreach/mailbox";
import {
  DUE_MESSAGE_COLUMNS,
  dueMessageFrom,
  sendOne,
  type SendContext,
} from "@/lib/outreach/send";
import { createSupabaseAdminClient, getSessionContext } from "@/lib/supabase/server";
import { optionalString } from "@/lib/supabase/row";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/outreach/queue — act on drafted messages.
 *
 * Three actions, and the difference between them is who decides:
 *
 * - **approve** marks a message ready. The send script picks it up on its next
 *   run, at its scheduled time.
 * - **skip** retires it. The lead is not written to.
 * - **send** does it now, through the same `sendOne` the script uses — so the
 *   suppression re-check, the compliance verdict, the daily cap and the
 *   duplicate protection all apply identically. A UI path that bypassed any of
 *   those would be a second, weaker set of rules that nobody remembers exists.
 *
 * ## Tenancy
 *
 * Messages are read through the caller's **own** client, so RLS decides which
 * ids resolve; an id belonging to another workspace comes back empty and is
 * reported as not found. The service role appears only after that, and only for
 * `email_accounts` — which denies all user access by policy and is the one
 * thing the caller's client cannot read.
 */

/** Bounded so one request cannot outlive the function's 60s budget. */
const MAX_BATCH = 25;

const bodySchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH),
  action: z.enum(["approve", "skip", "send"]),
});

export async function POST(request: Request) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "Outreach needs the database.", code: "not_configured" },
      { status: 503 },
    );
  }

  const session = await getSessionContext();
  if (!session) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (!session.orgId) {
    return NextResponse.json(
      { error: "Your workspace is not set up yet." },
      { status: 409 },
    );
  }
  const { supabase, orgId } = session;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Send at most ${MAX_BATCH} message ids and an action.` },
      { status: 400 },
    );
  }
  const { messageIds, action } = parsed.data;

  if (action !== "send") {
    // RLS scopes the update; a foreign id simply matches no rows.
    const { data, error } = await supabase
      .from("messages")
      .update({
        state: action === "approve" ? "approved" : "skipped",
        ...(action === "skip" ? { failure_reason: "Skipped by the user" } : {}),
        updated_at: new Date().toISOString(),
      })
      // Only messages still waiting. Re-approving something already sent would
      // put it back in the queue and send it twice.
      .in("state", ["drafted", "approved"])
      .in("id", messageIds)
      .select("id");

    if (error) {
      console.error("Updating the queue failed:", error.message);
      return NextResponse.json({ error: "Could not update those messages." }, { status: 500 });
    }
    return NextResponse.json({ action, updated: (data ?? []).length });
  }

  return sendNow(supabase, orgId, messageIds);
}

async function sendNow(
  supabase: Awaited<ReturnType<typeof getSessionContext>> extends null
    ? never
    : NonNullable<Awaited<ReturnType<typeof getSessionContext>>>["supabase"],
  orgId: string,
  messageIds: string[],
) {
  // Read through the caller's client first: this is the tenancy check, and
  // everything after it uses the service role.
  const { data, error } = await supabase
    .from("messages")
    .select(`${DUE_MESSAGE_COLUMNS}, campaigns(id, status, auto_send, daily_send_limit, compliance_ack_at, sender_email, agents(name, product_name))`)
    .in("state", ["drafted", "approved"])
    .in("id", messageIds);

  if (error) {
    console.error("Reading messages to send failed:", error.message);
    return NextResponse.json({ error: "Could not read those messages." }, { status: 500 });
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  if (rows.length === 0) {
    return NextResponse.json(
      { error: "Those messages are no longer waiting to be sent." },
      { status: 404 },
    );
  }

  const campaign = embedded(rows[0].campaigns);
  const agent = embedded(campaign?.agents);
  const admin = createSupabaseAdminClient();

  const mailbox = await findMailbox(admin, orgId, optionalString(campaign?.sender_email));
  if (!mailbox) {
    return NextResponse.json(
      {
        error: "No Gmail account is connected. Connect one in Settings first.",
        code: "no_mailbox",
      },
      { status: 409 },
    );
  }

  let gmail: GmailClient;
  try {
    const env = getEnv();
    gmail = new GmailClient(
      await accessTokenFor(admin, mailbox, {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        encryptionKey: env.ENCRYPTION_KEY,
      }),
    );
  } catch (error) {
    const needsReauth = error instanceof MailboxError && error.needsReauth;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not reach Gmail.",
        code: needsReauth ? "reauth_required" : "gmail_unavailable",
      },
      { status: needsReauth ? 409 : 502 },
    );
  }

  const productName = optionalString(agent?.product_name);
  const dailyLimit = Math.min(
    Number(campaign?.daily_send_limit ?? CONSERVATIVE_DAILY_LIMIT),
    CONSERVATIVE_DAILY_LIMIT,
  );

  const context: SendContext = {
    admin,
    orgId,
    gmail,
    sender: {
      email: mailbox.address,
      senderName: productName ?? optionalString(agent?.name) ?? "Cătină",
      senderCompany: productName ?? undefined,
      dataSource:
        "your company's details are on the Romanian trade register (ONRC) and " +
        "the tax register (ANAF)",
    },
    campaign: {
      id: String(campaign?.id ?? ""),
      /*
       * Forced on for this path, and only this path. The user pressed a button
       * labelled "Approve & send" on a message they can see — that *is* the
       * human review that `auto_send: false` exists to require, so deferring to
       * the campaign flag here would refuse the one thing they just asked for.
       */
      autoSend: true,
      // Likewise: pressing send on a visible message resumes it for that
      // message. A paused campaign still blocks the unattended script.
      active: true,
      dailyLimit,
      complianceAcknowledged: optionalString(campaign?.compliance_ack_at) !== null,
    },
    sentToday: await sentToday(admin, orgId),
    appUrl: getEnv().NEXT_PUBLIC_APP_URL,
  };

  const results: { id: string; state: string; reason?: string }[] = [];

  for (const row of rows) {
    const message = dueMessageFrom(row);
    if (!message) {
      results.push({ id: String(row.id), state: "skipped", reason: "No address on file" });
      continue;
    }

    try {
      const outcome = await sendOne(context, message);
      results.push({
        id: message.id,
        state: outcome.state,
        reason: "reason" in outcome ? outcome.reason : undefined,
      });

      if (outcome.state === "sent") {
        context.sentToday += 1;
        await recordSend(admin, mailbox);
      }
      // A cap or a rate limit applies to everything behind it too.
      if (outcome.state === "deferred" && outcome.code === "daily_limit") break;
    } catch (error) {
      // `sendOne` throws only when Gmail accepted a message and we could not
      // record it. Continuing would risk re-sending, so the request stops.
      console.error("Sending stopped:", error instanceof Error ? error.message : error);
      return NextResponse.json(
        {
          error:
            "A message was sent but could not be recorded, so sending stopped. " +
            "Check the queue before retrying.",
          results,
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ action: "send", results });
}

function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
