import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptToken, encryptToken } from "./crypto";
import { GmailError, refreshAccessToken } from "./gmail";

/**
 * The connected mailbox: storing it, and getting a usable access token back out.
 *
 * `email_accounts` is the one table in this schema that denies **all** user
 * access by RLS — service role only — because a row in it is a credential that
 * can send mail as the user. Every function here therefore takes an admin
 * client, and every one of them takes the `orgId` separately rather than
 * trusting an id that arrived with the request: with RLS bypassed, the
 * `.eq("org_id", …)` below *is* the tenancy boundary.
 *
 * ## What is stored, and what is not
 *
 * Only the refresh token, encrypted. Access tokens live an hour and are minted
 * on demand, so persisting one buys nothing and widens the blast radius of a
 * database leak by exactly one more credential.
 *
 * ## Why the daily count is read from `messages` and not from this table
 *
 * `email_accounts.daily_sent_count` exists and is maintained here, but it is a
 * cache and `sentToday` does not read it. A counter can drift — a send that
 * succeeds at Gmail and then fails to write leaves the counter low, and the
 * next run happily exceeds the cap. The `messages` rows cannot drift, because a
 * row in state `sent` carrying a `sent_at` *is* what "sent" means here. The
 * cache stays for the UI, which wants a number without a second query.
 */

/** One literal: supabase-js reads it at the type level, and `"a" + "b"` widens. */
export const MAILBOX_COLUMNS =
  "id, org_id, user_id, address, encrypted_refresh_token, scopes, daily_sent_count, daily_count_reset_at, is_active, created_at";

export type Mailbox = {
  id: string;
  orgId: string;
  userId: string;
  address: string;
  encryptedRefreshToken: string;
  scopes: string[];
  dailySentCount: number;
  dailyCountResetAt: string | null;
  isActive: boolean;
};

export function mailboxFrom(row: Record<string, unknown>): Mailbox {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    address: String(row.address),
    encryptedRefreshToken: String(row.encrypted_refresh_token),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
    dailySentCount: Number(row.daily_sent_count ?? 0),
    dailyCountResetAt:
      typeof row.daily_count_reset_at === "string" ? row.daily_count_reset_at : null,
    isActive: row.is_active !== false,
  };
}

/**
 * Store a freshly authorised mailbox.
 *
 * Upserts on `(org_id, address)` — the table's own unique index — so
 * reconnecting the same Gmail account replaces the token rather than failing,
 * which is what a user who revoked access and came back expects.
 *
 * `is_active` is forced back to true on conflict. The commonest reason to
 * reconnect is that a refresh failed and the row was deactivated, and leaving
 * it false would make the reconnection appear to work and then send nothing.
 */
export async function connectMailbox(
  admin: SupabaseClient,
  input: {
    orgId: string;
    userId: string;
    address: string;
    refreshToken: string;
    scopes: string[];
    encryptionKey: string;
  },
): Promise<{ mailbox?: Mailbox; error?: string }> {
  const address = input.address.trim().toLowerCase();
  if (!address) return { error: "Google did not say which mailbox was connected." };

  let encrypted: string;
  try {
    encrypted = await encryptToken(input.refreshToken, input.encryptionKey);
  } catch (error) {
    return {
      error: `Could not encrypt the refresh token: ${message(error)}`,
    };
  }

  const { data, error } = await admin
    .from("email_accounts")
    .upsert(
      {
        org_id: input.orgId,
        user_id: input.userId,
        provider: "gmail",
        address,
        encrypted_refresh_token: encrypted,
        scopes: input.scopes,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,address" },
    )
    .select(MAILBOX_COLUMNS)
    .maybeSingle();

  if (error) return { error: `Saving the mailbox failed: ${error.message}` };
  if (!data) return { error: "The mailbox was saved but could not be read back." };
  return { mailbox: mailboxFrom(data as Record<string, unknown>) };
}

/** The org's sending mailbox. `address` picks one when several are connected. */
export async function findMailbox(
  admin: SupabaseClient,
  orgId: string,
  address?: string | null,
): Promise<Mailbox | null> {
  let query = admin
    .from("email_accounts")
    .select(MAILBOX_COLUMNS)
    .eq("org_id", orgId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1);

  if (address?.trim()) query = query.eq("address", address.trim().toLowerCase());

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error("Reading the mailbox failed:", error.message);
    return null;
  }
  return data ? mailboxFrom(data as Record<string, unknown>) : null;
}

/** Every mailbox on the org, for the settings screen. */
export async function listMailboxes(
  admin: SupabaseClient,
  orgId: string,
): Promise<Mailbox[]> {
  const { data, error } = await admin
    .from("email_accounts")
    .select(MAILBOX_COLUMNS)
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Listing mailboxes failed:", error.message);
    return [];
  }
  return (data ?? []).map((row) => mailboxFrom(row as Record<string, unknown>));
}

export class MailboxError extends Error {
  constructor(
    message: string,
    /** True when the only fix is the user reconnecting the account. */
    readonly needsReauth = false,
  ) {
    super(message);
    this.name = "MailboxError";
  }
}

/**
 * An access token good for the next hour.
 *
 * Minted on every call rather than cached. A cache would need invalidating
 * across processes for a token that costs one HTTP round trip, and the send
 * loop asks once per run rather than once per message.
 *
 * A revoked grant deactivates the row on the way out. Google answers a revoked
 * refresh token with a 400 forever, so a run that keeps retrying burns quota
 * and — worse — reports "sending failed" every day without ever surfacing the
 * one thing the user can act on.
 */
export async function accessTokenFor(
  admin: SupabaseClient,
  mailbox: Mailbox,
  env: { clientId?: string; clientSecret?: string; encryptionKey: string },
): Promise<string> {
  if (!env.clientId || !env.clientSecret) {
    throw new MailboxError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so no token can be refreshed.",
    );
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptToken(mailbox.encryptedRefreshToken, env.encryptionKey);
  } catch (error) {
    // A wrong ENCRYPTION_KEY and a tampered ciphertext are indistinguishable by
    // design. Either way the stored token is unusable and reconnecting is the
    // only route back.
    throw new MailboxError(
      `The stored refresh token for ${mailbox.address} could not be decrypted ` +
        `(${message(error)}). Reconnect the mailbox.`,
      true,
    );
  }

  try {
    const tokens = await refreshAccessToken({
      refreshToken,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
    });
    return tokens.accessToken;
  } catch (error) {
    if (error instanceof GmailError && error.needsReauth) {
      await deactivateMailbox(admin, mailbox.id, "Google rejected the refresh token");
      throw new MailboxError(
        `${mailbox.address} needs reconnecting — Google rejected the stored ` +
          "authorisation. That happens when access is revoked or the password changes.",
        true,
      );
    }
    throw new MailboxError(`Could not get a Gmail token: ${message(error)}`);
  }
}

export async function deactivateMailbox(
  admin: SupabaseClient,
  mailboxId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin
    .from("email_accounts")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", mailboxId);
  if (error) console.error(`Deactivating the mailbox failed (${reason}):`, error.message);
}

/**
 * How many messages this org has actually sent today.
 *
 * Counted from `messages`, not from the cached column — see the note at the top
 * of this file. `head: true`, so it costs a count rather than the rows.
 *
 * "Today" is the local day of whatever runs this. The send window
 * (`scheduleSendTimes`) is local too, and a cap rolling over at a different
 * hour than the schedule would let a run exceed it by sending the tail of one
 * day and the head of the next inside the same working afternoon.
 */
export async function sentToday(
  admin: SupabaseClient,
  orgId: string,
  now: Date = new Date(),
): Promise<number> {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const { count, error } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("state", "sent")
    .gte("sent_at", start.toISOString());

  if (error) {
    // Fail closed on the cap. Reporting zero would uncap the run, and the daily
    // limit is a deliverability protection rather than a formality.
    console.error("Counting today's sends failed:", error.message);
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

/** Local `YYYY-MM-DD`, matching the `date` column the cache resets on. */
export function localDateKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Bump the display cache after a send.
 *
 * Read-modify-write, which is a race if two senders ever run at once. Tolerable
 * *only* because nothing gates on this value: the cap reads `sentToday`, which
 * counts rows. If this ever becomes a gate, make it an atomic increment first.
 */
export async function recordSend(
  admin: SupabaseClient,
  mailbox: Mailbox,
  now: Date = new Date(),
): Promise<void> {
  const today = localDateKey(now);
  const rolledOver = mailbox.dailyCountResetAt !== today;

  const { error } = await admin
    .from("email_accounts")
    .update({
      daily_sent_count: rolledOver ? 1 : mailbox.dailySentCount + 1,
      daily_count_reset_at: today,
      updated_at: now.toISOString(),
    })
    .eq("id", mailbox.id);

  if (error) console.error("Updating the mailbox send count failed:", error.message);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
