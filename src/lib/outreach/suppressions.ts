import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The do-not-contact list, and the only hard block in the send path.
 *
 * `guardSend` and `evaluateCompliance` both take `suppressed: boolean` and both
 * treat it as the one verdict that is not a judgement call. Neither of them has
 * ever been handed a real value: the `suppressions` table exists, carries a
 * unique index, is listed in the RLS policies — and nothing reads or writes it.
 *
 * That is the same shape as the two constant zeros this project already found
 * the hard way — a correct pure function starved of input, which looks like
 * working code and behaves like a missing feature. Here the failure mode is
 * worse than a low score: it is mailing somebody who asked not to be mailed.
 *
 * ## Address or domain
 *
 * A suppression entry is either a full address or a bare domain, and a domain
 * entry has to shadow every address under it. "Take our whole company off your
 * list" is the most common way an opt-out actually arrives in B2B, and honouring
 * it only for the one person who wrote is how the second complaint happens.
 */

/** Normalise the way the unique index expects: lower case, trimmed. */
export function normaliseSuppression(value: string): string {
  return value.trim().toLowerCase();
}

/** The domain half of an address, or null when it is not one. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1);
}

export type SuppressionReason = "unsubscribed" | "bounced" | "complaint" | "manual";

export type SuppressionEntry = {
  value: string;
  kind: "address" | "domain";
  reason: SuppressionReason;
};

/**
 * Which of these addresses must not be contacted.
 *
 * Batched rather than one lookup per recipient: a campaign send resolves
 * hundreds at once, and a query each is how this becomes an N+1 against a
 * hosted database — the same mistake `knownRoleEmailsFor` was written to avoid.
 *
 * Fails **closed**. If the lookup errors, every address is reported suppressed,
 * because the alternative is mailing an opt-out because PostgREST was briefly
 * unavailable. A blocked send is recoverable; an ignored opt-out is not.
 */
export async function suppressedAmong(
  db: SupabaseClient,
  orgId: string,
  addresses: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map(normaliseSuppression))].filter(Boolean);
  if (wanted.length === 0) return new Set();

  const domains = [...new Set(wanted.map(domainOf).filter((d): d is string => d !== null))];

  const { data, error } = await db
    .from("suppressions")
    .select("value, kind")
    .eq("org_id", orgId)
    .in("value", [...wanted, ...domains]);

  if (error) {
    console.error("Reading the suppression list failed:", error.message);
    // Fail closed. See the note above.
    return new Set(wanted);
  }

  const suppressedValues = new Set(
    (data ?? []).map((row) => normaliseSuppression(String((row as { value: unknown }).value))),
  );

  const blocked = new Set<string>();
  for (const address of wanted) {
    const domain = domainOf(address);
    if (suppressedValues.has(address) || (domain && suppressedValues.has(domain))) {
      blocked.add(address);
    }
  }
  return blocked;
}

/** One address, for the send-time re-check that `guardSend` documents. */
export async function isSuppressed(
  db: SupabaseClient,
  orgId: string,
  address: string,
): Promise<boolean> {
  return (await suppressedAmong(db, orgId, [address])).size > 0;
}

/**
 * Add entries, idempotently.
 *
 * Upserts on `(org_id, value)` — the table's own unique index — so an
 * unsubscribe link clicked twice, or a bounce webhook delivered twice, does not
 * fail. The reason is *not* overwritten on conflict: an address that
 * unsubscribed and later hard-bounced is still, first and foremost, an
 * unsubscribe, and that is the record worth keeping if anyone ever asks why we
 * stopped mailing them.
 */
export async function suppress(
  admin: SupabaseClient,
  orgId: string,
  entries: readonly SuppressionEntry[],
): Promise<{ written: number; error?: string }> {
  const rows = entries
    .map((entry) => ({
      org_id: orgId,
      value: normaliseSuppression(entry.value),
      kind: entry.kind,
      reason: entry.reason,
    }))
    .filter((row) => row.value.length > 0);

  if (rows.length === 0) return { written: 0 };

  const { error } = await admin
    .from("suppressions")
    .upsert(rows, { onConflict: "org_id,value", ignoreDuplicates: true });

  if (error) return { written: 0, error: `Writing the suppression list failed: ${error.message}` };
  return { written: rows.length };
}

/**
 * Classify what a person typed into the manual "do not contact" box.
 *
 * `firma.ro` is a domain, `ion@firma.ro` is an address, and getting it wrong in
 * the lenient direction — storing a domain as an address — silently suppresses
 * nothing at all, because no address ever equals a bare domain.
 */
export function classifySuppression(raw: string): SuppressionEntry | null {
  const value = normaliseSuppression(raw).replace(/^@/, "");
  if (!value) return null;

  if (value.includes("@")) {
    return domainOf(value)
      ? { value, kind: "address", reason: "manual" }
      : null;
  }

  // A bare token with no dot is neither; rejecting it beats storing a typo that
  // silently blocks nothing.
  if (!value.includes(".")) return null;
  return { value, kind: "domain", reason: "manual" };
}
