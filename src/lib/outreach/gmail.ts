import { z } from "zod";
import { buildMimeMessage, toGmailRaw, type BuildMessageInput } from "./mime";

/**
 * Gmail API client.
 *
 * Scopes are the important decision here. `gmail.send` and `gmail.compose` are
 * both *sensitive* scopes, not *restricted* ones, which means Google's ~10-day
 * verification applies but the CASA Tier 2 security assessment ($540–1,000
 * plus annual recertification) does not. Reaching for `gmail.modify` or
 * `https://mail.google.com/` for convenience would cross that line and add a
 * recurring audit obligation to a product that does not need one.
 *
 * Unverified, Google caps the app at 100 test users — more than enough for an
 * MVP, and worth knowing before the cap is hit rather than after.
 */

export const GMAIL_SCOPES = [
  // Send on the user's behalf. Sensitive, not restricted.
  "https://www.googleapis.com/auth/gmail.send",
  // Create drafts, which is the default posture: review before send.
  "https://www.googleapis.com/auth/gmail.compose",
  // Identifies which mailbox was connected.
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Consumer Gmail allows ~500 recipients/day; Workspace ~2,000. The default is
 * far below either, because cold outreach that approaches the platform limit
 * is already past the point where deliverability collapses.
 */
export const CONSERVATIVE_DAILY_LIMIT = 30;

const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  })
  .loose();

const sendResponseSchema = z
  .object({
    id: z.string().optional(),
    threadId: z.string().optional(),
    labelIds: z.array(z.string()).optional(),
  })
  .loose();

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True when re-authorising the mailbox is the fix. */
    readonly needsReauth = false,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

/** Consent URL. `prompt=consent` forces a refresh token to be issued. */
export function buildAuthUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    // Required for a refresh token; without it we get an access token that
    // expires in an hour and no way to renew it.
    access_type: "offline",
    // Google only returns a refresh token on first consent unless forced, so
    // a user who reconnects would otherwise leave us unable to send.
    prompt: "consent",
    include_granted_scopes: "true",
    state: options.state,
  });
  if (options.loginHint) params.set("login_hint", options.loginHint);

  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  grantedScopes: string[];
};

export async function exchangeCodeForTokens(options: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new GmailError(
      `Token exchange failed: ${await response.text().catch(() => response.statusText)}`,
      response.status,
    );
  }

  const parsed = tokenResponseSchema.parse(await response.json());
  const granted = parsed.scope?.split(" ") ?? [];

  // Fail here rather than at send time: a user who unticked a permission on
  // the consent screen should find out now, not when a campaign silently
  // stops working.
  if (!granted.includes("https://www.googleapis.com/auth/gmail.send")) {
    throw new GmailError(
      "The send permission wasn't granted. Reconnect and leave all boxes ticked.",
      undefined,
      true,
    );
  }

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: new Date(Date.now() + (parsed.expires_in ?? 3600) * 1000),
    grantedScopes: granted,
  };
}

export async function refreshAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenSet> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // A revoked or expired grant is permanent — retrying wastes calls and
    // hides the fact that the user has to reconnect.
    const revoked = response.status === 400 || response.status === 401;
    throw new GmailError(
      `Could not refresh the Gmail token: ${body.slice(0, 200)}`,
      response.status,
      revoked,
    );
  }

  const parsed = tokenResponseSchema.parse(await response.json());
  return {
    accessToken: parsed.access_token,
    // Google does not reissue the refresh token on renewal; keep the old one.
    refreshToken: parsed.refresh_token ?? options.refreshToken,
    expiresAt: new Date(Date.now() + (parsed.expires_in ?? 3600) * 1000),
    grantedScopes: parsed.scope?.split(" ") ?? [],
  };
}

/**
 * Which mailbox the user just connected.
 *
 * Asked of Google rather than of our own session, and the difference matters:
 * a user signed into the app as one address can perfectly well authorise a
 * different Gmail account on the consent screen. Storing the session email
 * would label the row with an address the token cannot send as, and the
 * mismatch would only surface as a bounced From header much later.
 *
 * `userinfo.email` is one of the scopes requested for exactly this.
 */
export async function fetchConnectedAddress(accessToken: string): Promise<string> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new GmailError(
      `Could not read which Google account was connected (${response.status}).`,
      response.status,
    );
  }

  const parsed = z
    .object({ email: z.string().optional(), email_verified: z.boolean().optional() })
    .loose()
    .parse(await response.json());

  if (!parsed.email) {
    throw new GmailError("Google returned no email address for the connected account.");
  }
  return parsed.email;
}

export type SendResult = {
  messageId: string;
  threadId?: string;
};

export class GmailClient {
  constructor(private readonly accessToken: string) {}

  /** Creates a draft in the user's mailbox — the default, review-first path. */
  async createDraft(message: BuildMessageInput): Promise<SendResult> {
    const raw = toGmailRaw(buildMimeMessage(message));
    const body = await this.call("/drafts", {
      message: { raw },
    });

    const draft = z
      .object({ id: z.string().optional(), message: sendResponseSchema.optional() })
      .loose()
      .parse(body);

    return {
      // The draft id is what we need to find or send it later; the inner
      // message id changes when the draft is sent.
      messageId: draft.id ?? draft.message?.id ?? "",
      threadId: draft.message?.threadId,
    };
  }

  async send(message: BuildMessageInput): Promise<SendResult> {
    const raw = toGmailRaw(buildMimeMessage(message));
    const parsed = sendResponseSchema.parse(await this.call("/messages/send", { raw }));

    if (!parsed.id) {
      throw new GmailError("Gmail accepted the request but returned no message id");
    }
    return { messageId: parsed.id, threadId: parsed.threadId };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const parsed = sendResponseSchema.parse(
      await this.call("/drafts/send", { id: draftId }),
    );
    if (!parsed.id) {
      throw new GmailError("Gmail accepted the draft send but returned no message id");
    }
    return { messageId: parsed.id, threadId: parsed.threadId };
  }

  private async call(path: string, payload: unknown): Promise<unknown> {
    const response = await fetch(`${GMAIL_API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) return response.json();

    const body = await response.text().catch(() => "");

    if (response.status === 401) {
      throw new GmailError("Gmail rejected the token", 401, true);
    }
    if (response.status === 403 && /quota|rateLimit/i.test(body)) {
      // Distinct from a permission problem: this one resolves by waiting.
      throw new GmailError(
        "Gmail rate limit or daily quota reached — the send will be retried later",
        403,
      );
    }
    if (response.status === 429) {
      throw new GmailError("Gmail rate limit reached", 429);
    }

    throw new GmailError(
      `Gmail API error ${response.status}: ${body.slice(0, 300)}`,
      response.status,
    );
  }
}
