import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getEnv, getPublicEnv } from "@/lib/env";
import type { Database } from "./types";

/**
 * Request-scoped client carrying the user's session. Every query made through
 * it is subject to RLS (see drizzle/policies.sql) — this is the client that
 * should be used for anything reached from a route handler or server component.
 */
export async function createSupabaseServerClient() {
  const env = getPublicEnv();
  const cookieStore = await cookies();

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Session refresh is handled by middleware instead.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Only for background workers writing shared reference data (companies, people,
 * emails, signals) and for reading `email_accounts` / `provider_usage`, which
 * deny all user access by design. Never construct this in a path that can be
 * reached by a user-supplied org id without checking membership first.
 */
export function createSupabaseAdminClient(bindings?: Record<string, unknown>) {
  const env = getEnv(bindings);
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Resolve the caller's user + org, or null when unauthenticated. */
export async function getSessionContext() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("memberships")
    .select("org_id, role")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();

  if (!membership) return { user, orgId: null, role: null, supabase };

  return {
    user,
    orgId: membership.org_id as string,
    role: membership.role as "owner" | "admin" | "member",
    supabase,
  };
}
