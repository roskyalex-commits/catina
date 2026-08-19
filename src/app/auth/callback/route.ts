import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /auth/callback — where Supabase sends a confirmation or recovery link.
 *
 * Exchanges the one-time code for a session, then hands off to /auth/bootstrap
 * so a confirmed user gets a workspace on the same round trip.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/app";

  if (!code) {
    const back = new URL("/login", url.origin);
    back.searchParams.set("error", "That sign-in link is missing its code.");
    return NextResponse.redirect(back);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const back = new URL("/login", url.origin);
    back.searchParams.set(
      "error",
      "That link has expired or was already used. Request a new one.",
    );
    return NextResponse.redirect(back);
  }

  const bootstrap = new URL("/auth/bootstrap", url.origin);
  bootstrap.searchParams.set("next", next);
  return NextResponse.redirect(bootstrap);
}
