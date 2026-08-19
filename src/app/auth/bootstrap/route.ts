import { NextResponse } from "next/server";
import { ensureOrgForUser } from "@/lib/auth/ensure-org";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /auth/bootstrap — creates the caller's workspace, then sends them on.
 *
 * A route rather than a call inside the app layout: creating an org is a write,
 * and a Server Component that writes on render will run it again on every
 * refresh, prefetch and parallel segment. The layout redirects here when it
 * sees a session with no org, and this redirects back once.
 *
 * The user id comes from `getUser()`, which verifies the JWT against Supabase —
 * never from a query parameter.
 */
export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const origin = new URL(request.url).origin;
  if (!user) return NextResponse.redirect(new URL("/login", origin));

  const result = await ensureOrgForUser(user.id, user.email ?? "");

  if (!result.ok) {
    const url = new URL("/login", origin);
    url.searchParams.set("error", `Could not create your workspace: ${result.error}`);
    return NextResponse.redirect(url);
  }

  const next = new URL(request.url).searchParams.get("next");
  // Only same-origin relative paths — an open redirect here would be handed a
  // freshly authenticated session.
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/app";

  return NextResponse.redirect(new URL(target, origin));
}
