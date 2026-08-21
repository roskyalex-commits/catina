import { NextResponse } from "next/server";
import { getEnv, getPublicEnv } from "@/lib/env";
import { buildAuthUrl } from "@/lib/outreach/gmail";
import { getSessionContext } from "@/lib/supabase/server";
import { OAUTH_STATE_COOKIE, googleRedirectUri, newOauthState } from "../state";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/auth/google/start — begin connecting a Gmail account.
 *
 * A redirect rather than a JSON endpoint, because the browser has to end up on
 * Google's consent screen and only a top-level navigation can do that.
 *
 * The `state` parameter is the CSRF defence and it is not decoration. Without
 * it, anyone can send a signed-in user to our callback carrying *their own*
 * authorisation code, and we would dutifully attach the attacker's mailbox to
 * the victim's workspace — after which every message the victim's agent sends
 * leaves from an inbox the attacker reads. So a random value goes into an
 * httpOnly cookie here and must come back matching in the callback.
 *
 * `sameSite: "lax"` on purpose: `strict` would withhold the cookie on the
 * top-level navigation *back* from Google and break every connection attempt,
 * while `lax` still withholds it from cross-site POSTs and subresources.
 */
export async function GET() {
  const session = await getSessionContext();
  if (!session) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  if (!session.orgId) {
    return NextResponse.json(
      { error: "Your workspace is not set up yet. Reload to finish signing in." },
      { status: 409 },
    );
  }

  let clientId: string | undefined;
  try {
    clientId = getEnv().GOOGLE_CLIENT_ID;
  } catch {
    clientId = undefined;
  }

  if (!clientId) {
    // The commonest state of this feature on a fresh checkout, so it says what
    // to do rather than 500-ing on a missing variable.
    return NextResponse.json(
      {
        error:
          "Gmail is not configured. Create an OAuth client in Google Cloud " +
          "(APIs & Services → Credentials → OAuth client ID → Web application), " +
          "add the redirect URI shown in docs/OUTREACH.md, then set " +
          "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local.",
        code: "not_configured",
      },
      { status: 503 },
    );
  }

  const state = newOauthState();
  const url = buildAuthUrl({
    clientId,
    redirectUri: googleRedirectUri(getPublicEnv().NEXT_PUBLIC_APP_URL),
    state,
    // Pre-fills the account chooser with the address they signed in as. Only a
    // hint — the user may still pick a different mailbox, which is why the
    // callback asks Google which one it actually got.
    loginHint: session.user.email ?? undefined,
  });

  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/v1/auth/google",
    // Long enough to read a consent screen, short enough that an abandoned
    // attempt does not leave a usable token lying in the browser.
    maxAge: 600,
  });
  return response;
}
