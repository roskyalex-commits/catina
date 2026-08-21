/**
 * Shared between the two halves of the Gmail OAuth dance.
 *
 * Kept out of both route files so the cookie name and the redirect URI are
 * written once. A redirect URI that differs by one character between the
 * authorisation request and the token exchange fails with
 * `redirect_uri_mismatch`, and Google will not tell you which end is wrong.
 */

export const OAUTH_STATE_COOKIE = "catina_google_oauth_state";

/** Must match, byte for byte, what is registered in the Google Cloud console. */
export function googleRedirectUri(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/v1/auth/google/callback`;
}

/** 32 bytes of entropy, hex — unguessable, and safe in a URL as-is. */
export function newOauthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of the returned state against the cookie.
 *
 * `===` would leak the shared prefix through timing. That is a thin attack on
 * a value that lives ten minutes, but the correct comparison is three lines and
 * the incorrect one invites the question at every review.
 */
export function statesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
