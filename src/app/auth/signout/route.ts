import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /auth/signout. POST rather than GET so a prefetch, a link scanner or an
 * embedded image cannot sign the user out.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", new URL(request.url).origin), {
    status: 303,
  });
}
