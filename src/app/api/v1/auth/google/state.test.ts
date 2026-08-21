import { describe, expect, it } from "vitest";
import { googleRedirectUri, newOauthState, statesMatch } from "./state";

/**
 * The `state` parameter is the CSRF defence on the Gmail connection, and its
 * failure mode is not an error message: without it, anyone can send a signed-in
 * user to our callback carrying *their own* authorisation code, and we attach
 * the attacker's mailbox to the victim's workspace. Every message the victim's
 * agent then sends leaves from an inbox the attacker reads.
 */

describe("state matching", () => {
  it("accepts the value it issued", () => {
    const state = newOauthState();
    expect(statesMatch(state, state)).toBe(true);
  });

  it("rejects a different value", () => {
    expect(statesMatch(newOauthState(), newOauthState())).toBe(false);
  });

  it("rejects a missing value on either side", () => {
    // A callback with no cookie is the exact shape of the attack. It must not
    // fall through to "well, nothing to compare, carry on".
    const state = newOauthState();
    expect(statesMatch(undefined, state)).toBe(false);
    expect(statesMatch(state, undefined)).toBe(false);
    expect(statesMatch(undefined, undefined)).toBe(false);
    expect(statesMatch("", "")).toBe(false);
  });

  it("rejects a prefix of the real value", () => {
    const state = newOauthState();
    expect(statesMatch(state.slice(0, -1), state)).toBe(false);
  });
});

describe("the issued state", () => {
  it("is long enough to be unguessable and fresh each time", () => {
    // 32 bytes as hex.
    expect(newOauthState()).toMatch(/^[0-9a-f]{64}$/);
    expect(newOauthState()).not.toBe(newOauthState());
  });
});

describe("the redirect URI", () => {
  it("matches byte for byte whatever the app URL's trailing slash does", () => {
    /*
     * A redirect URI that differs by one character between the authorisation
     * request and the token exchange fails with `redirect_uri_mismatch`, and
     * Google does not say which end is wrong. A trailing slash in
     * NEXT_PUBLIC_APP_URL is the way that happens in practice.
     */
    const expected = "https://catina.ro/api/v1/auth/google/callback";
    expect(googleRedirectUri("https://catina.ro")).toBe(expected);
    expect(googleRedirectUri("https://catina.ro/")).toBe(expected);
    expect(googleRedirectUri("https://catina.ro///")).toBe(expected);
  });
});
