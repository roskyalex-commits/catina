import { listMailboxes } from "@/lib/outreach/mailbox";
import { createSupabaseAdminClient, getSessionContext } from "@/lib/supabase/server";
import { isDemoMode } from "./demo";

/**
 * Connected sending mailboxes, for the settings screen.
 *
 * Reads through the **service role**, unlike every other accessor here, because
 * `email_accounts` denies all user access by RLS — a row in it is a credential
 * that can send mail. The tenancy check is therefore explicit: the org id comes
 * from the resolved session and is passed as a filter, never taken from a
 * request parameter.
 *
 * Only the address and its state are returned. The encrypted token stays in the
 * database; there is no reason for it to cross into a React tree.
 */

export type MailboxSummary = {
  address: string;
  isActive: boolean;
  /** True when the send scope was granted. Without it nothing can be sent. */
  canSend: boolean;
  sentToday: number;
};

export async function listConnectedMailboxes(): Promise<MailboxSummary[]> {
  // The demo dataset has no mailbox on purpose: "not connected" is the honest
  // state for a workspace that has never authorised one, and inventing one here
  // would show a Connect button that is already green.
  if (isDemoMode()) return [];

  const session = await getSessionContext();
  if (!session?.orgId) return [];

  try {
    const mailboxes = await listMailboxes(createSupabaseAdminClient(), session.orgId);
    return mailboxes.map((mailbox) => ({
      address: mailbox.address,
      isActive: mailbox.isActive,
      canSend: mailbox.scopes.includes("https://www.googleapis.com/auth/gmail.send"),
      sentToday: mailbox.dailySentCount,
    }));
  } catch (error) {
    // A missing SUPABASE_SERVICE_ROLE_KEY throws here. The settings page is
    // exactly where someone goes to find out what is not configured, so it must
    // render rather than 500.
    console.error(
      "Listing mailboxes failed:",
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}
