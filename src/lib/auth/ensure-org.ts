import { requireString } from "@/lib/supabase/row";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { orgNameFromEmail, slugCandidates, slugFromEmail } from "./org";

export type EnsureOrgResult =
  | { ok: true; orgId: string; created: boolean }
  | { ok: false; error: string };

/**
 * Give a user an org, or return the one they already have.
 *
 * Idempotent: safe to call on every sign-in, and safe to call twice
 * concurrently — the unique index on `orgs.slug` is what actually arbitrates a
 * race, and a collision just moves to the next candidate.
 *
 * Uses the service role because RLS gives `authenticated` no insert on `orgs`.
 * That makes this function security-sensitive: it must only ever be called with
 * a `userId` taken from a verified session, never from a request body.
 */
export async function ensureOrgForUser(
  userId: string,
  email: string,
): Promise<EnsureOrgResult> {
  const admin = createSupabaseAdminClient();

  const { data: existing, error: readError } = await admin
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (readError) return { ok: false, error: readError.message };
  if (existing) {
    return {
      ok: true,
      orgId: requireString(existing.org_id, "memberships.org_id"),
      created: false,
    };
  }

  const base = slugFromEmail(email);
  const name = orgNameFromEmail(email);

  for (const slug of slugCandidates(base)) {
    const { data: org, error } = await admin
      .from("orgs")
      .insert({ name, slug, home_country: "RO", plan: "free" })
      .select("id")
      .single();

    if (error) {
      // 23505 = unique_violation. Another account already holds this slug —
      // including one created by a concurrent request for this same user, so
      // re-check membership before trying the next candidate.
      if (error.code !== "23505") return { ok: false, error: error.message };

      const { data: raced } = await admin
        .from("memberships")
        .select("org_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle();
      if (raced) {
        return {
          ok: true,
          orgId: requireString(raced.org_id, "memberships.org_id"),
          created: false,
        };
      }

      continue;
    }

    const orgId = requireString(org.id, "orgs.id");

    const { error: membershipError } = await admin
      .from("memberships")
      .insert({ org_id: orgId, user_id: userId, role: "owner" });

    if (membershipError) {
      // The org exists but nobody can reach it. Remove it rather than leaving
      // an orphan that will collide with this user's next attempt.
      await admin.from("orgs").delete().eq("id", orgId);
      return { ok: false, error: membershipError.message };
    }

    return { ok: true, orgId, created: true };
  }

  return {
    ok: false,
    error: `Could not find a free workspace name based on "${base}".`,
  };
}
