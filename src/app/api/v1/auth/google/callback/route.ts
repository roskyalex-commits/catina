import { NextResponse } from "next/server";
import { getEnv, getPublicEnv } from "@/lib/env";
import { exchangeCodeForTokens, fetchConnectedAddress } from "@/lib/outreach/gmail";
import { connectMailbox } from "@/lib/outreach/mailbox";
import { createSupabaseAdminClient, getSessionContext } from "@/lib/supabase/server";
import { OAUTH_STATE_COOKIE, googleRedirectUri, statesMatch } from "../state";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/auth/google/callback — Google sends the user back here.
 *
 * Always ends in a redirect to the settings page, never in JSON: the browser
 * arrived by top-level navigation and the person is looking at a page, not at
 * a response body. The outcome is carried in the query string so the settings
 * page can say what happened in the user's own language.
 *
 * The order of checks below is the security-relevant part.
 *
 *   1. **Session first.** A callback with no session has nobody to attach a
 *      mailbox to, and proceeding would mean guessing at an org.
 *   2. **State before code.** The state cookie proves this callback belongs to
 *      an authorisation *we* started. Exchanging the code first would mean
 *      spending an attacker-supplied code before checking whether we asked for
 *      it — see the note in `start/route.ts` for what that buys them.
 *   3. **Ask Google which mailbox.** Not the session email; the user may have
 *      picked a different account on the consent screen.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const settings = new URL("/app/settings", getPublicEnv().NEXT_PUBLIC_APP_URL);

  const fail = (reason: string) => {
    settings.searchParams.set("mailbox", "error");
    settings.searchParams.set("reason", reason);
    return withClearedState(NextResponse.redirect(settings));
  };

  // The user pressed Cancel, or unticked a permission. Not an error worth a
  // stack trace, but it must not read as success either.
  const denied = url.searchParams.get("error");
  if (denied) {
    return fail(
      denied === "access_denied"
        ? "You cancelled before granting access."
        : `Google refused the request (${denied}).`,
    );
  }

  const session = await getSessionContext();
  if (!session?.orgId) {
    return fail("Your session expired while you were at Google. Sign in and try again.");
  }

  const returnedState = url.searchParams.get("state") ?? undefined;
  const cookieState = cookieValue(request, OAUTH_STATE_COOKIE);
  if (!statesMatch(returnedState, cookieState)) {
    // Either a genuinely forged callback or a stale tab. Both get the same
    // answer, because we cannot tell them apart and the fix is the same.
    return fail(
      "That connection link was not one this browser started. Try connecting again.",
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return fail("Google sent no authorisation code.");

  let env;
  try {
    env = getEnv();
  } catch {
    return fail("The server is missing its environment configuration.");
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return fail("Gmail is not configured on this server.");
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: googleRedirectUri(getPublicEnv().NEXT_PUBLIC_APP_URL),
    });

    if (!tokens.refreshToken) {
      /*
       * `prompt=consent` in `buildAuthUrl` is what makes this rare, but it does
       * still happen — most often when the same account was connected before
       * and Google decides the grant already exists. Without a refresh token we
       * can send for exactly one hour and then go silent, which is a far worse
       * outcome than refusing now.
       */
      return fail(
        "Google did not return a refresh token. Remove this app at " +
          "myaccount.google.com/permissions and connect again.",
      );
    }

    const address = await fetchConnectedAddress(tokens.accessToken);

    // Service role: `email_accounts` denies all user access by policy, so the
    // caller's own client cannot write it. The org id comes from the session
    // resolved above, never from the request.
    const admin = createSupabaseAdminClient();
    const saved = await connectMailbox(admin, {
      orgId: session.orgId,
      userId: session.user.id,
      address,
      refreshToken: tokens.refreshToken,
      scopes: tokens.grantedScopes,
      encryptionKey: env.ENCRYPTION_KEY,
    });

    if (saved.error || !saved.mailbox) {
      console.error("Connecting the mailbox failed:", saved.error);
      return fail(saved.error ?? "The mailbox could not be saved.");
    }

    settings.searchParams.set("mailbox", "connected");
    settings.searchParams.set("address", saved.mailbox.address);
    return withClearedState(NextResponse.redirect(settings));
  } catch (error) {
    // Never log the code or the tokens: this path handles live credentials and
    // a stack trace in a shared log is how they leak.
    console.error(
      "Gmail OAuth callback failed:",
      error instanceof Error ? error.message : String(error),
    );
    return fail(
      error instanceof Error && error.message
        ? error.message
        : "Connecting the mailbox failed.",
    );
  }
}

/** The state cookie is single-use; leaving it behind lets a stale tab replay. */
function withClearedState(response: NextResponse): NextResponse {
  response.cookies.set(OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    path: "/api/v1/auth/google",
    maxAge: 0,
  });
  return response;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}
