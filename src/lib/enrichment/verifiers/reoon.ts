import type { MailboxVerifier, VerificationVerdict } from "../mx";

/**
 * Reoon, over its REST API.
 *
 * ## Why a vendor at all
 *
 * This is the component that makes the rest of the email work shippable. The
 * waterfall's standing rule is that a pattern-generated address is never
 * returned as the sendable `email` — only a vendor or a mailbox check may
 * promote it — so without a verifier the product generates addresses nobody is
 * allowed to send to.
 *
 * A local implementation is impossible rather than merely inconvenient.
 * Mailbox-level verification needs an SMTP `RCPT TO` probe on port 25;
 * Cloudflare Workers blocks outbound 25 and its TCP sockets do not change that,
 * and essentially every residential ISP blocks it too. So the choice is a
 * vendor or nothing.
 *
 * Reoon specifically: 600 verifications a month on the free tier with no card,
 * which is enough to prove the chain end to end on the leads that are actually
 * reachable today, and $9/month for 500/day after that.
 *
 * REST rather than a client library, matching `llm/gemini.ts` — one GET, and
 * the deploy target is Workers where every dependency is bundle weight.
 */

const ENDPOINT = "https://emailverifier.reoon.com/api/v1/verify";
/**
 * `power`, not `quick`.
 *
 * `quick` is syntax, disposable lists and MX — all of which we already do for
 * free in `MxChecker`, so paying a credit for it would buy nothing. `power` is
 * the one that actually probes the mailbox and reports catch-all, which is the
 * only reason to be here.
 */
const MODE = "power";
/** Power mode probes a real SMTP conversation, so it is not fast. */
const TIMEOUT_MS = 45_000;

type ReoonResponse = {
  status?: string;
  is_catch_all?: boolean;
  is_disposable?: boolean;
  is_role_account?: boolean;
  mx_accepts_mail?: boolean;
  reason?: string;
  error?: string;
};

/**
 * Reoon's power-mode vocabulary, mapped onto ours.
 *
 * The mapping that matters is `catch_all`. A catch-all domain accepts every
 * recipient, so the probe succeeded and proved nothing — calling that
 * `verified` is precisely the mistake `mx.ts` warns about at the top of the
 * file, and it is how a sending domain's reputation gets spent on addresses
 * that were never real. It becomes `risky`, and the caller must not auto-send.
 */
const STATUS_MAP: Record<string, VerificationVerdict["status"]> = {
  safe: "verified",
  // Reoon reports a confirmed role mailbox under its own label rather than
  // `safe`. It still completed the check, and role addresses are the ones this
  // product prefers for Romanian outreach anyway.
  role_account: "verified",
  invalid: "invalid",
  disabled: "invalid",
  spamtrap: "invalid",
  // Deliverable, but sending there is how a list gets flagged.
  disposable: "invalid",
  // The mailbox exists and is bouncing. Real, but not sendable today.
  inbox_full: "risky",
  catch_all: "risky",
  unknown: "unknown",
};

export class ReoonVerifier implements MailboxVerifier {
  readonly key = "reoon";
  readonly label = "Reoon (REOON_API_KEY)";

  private readonly apiKey?: string;

  /** Blank is unset — dotenv parses `KEY=` as `""`, not undefined. */
  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async verify(address: string): Promise<VerificationVerdict> {
    if (!this.apiKey) {
      return { address, status: "unknown", reason: "REOON_API_KEY is not set." };
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set("email", address);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("mode", MODE);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let payload: ReoonResponse;
    try {
      const response = await fetch(url, { signal: controller.signal });
      payload = (await response.json().catch(() => ({}))) as ReoonResponse;

      if (!response.ok) {
        /*
         * `unknown`, not `invalid`. An exhausted quota or a bad key says
         * nothing about the address, and returning `invalid` would let a
         * billing problem quietly delete every candidate it touched.
         */
        return {
          address,
          status: "unknown",
          reason: payload.error ?? `${response.status} ${response.statusText}`,
        };
      }
    } catch (error) {
      return {
        address,
        status: "unknown",
        reason:
          error instanceof Error && error.name === "AbortError"
            ? `Reoon did not answer within ${TIMEOUT_MS / 1000}s.`
            : String(error),
      };
    } finally {
      clearTimeout(timer);
    }

    const raw = payload.status ?? "unknown";
    const status = STATUS_MAP[raw] ?? "unknown";

    return {
      address,
      status,
      // The vendor's own word, kept verbatim: `catch_all` and `disabled` both
      // map to statuses that hide which one happened, and that is exactly what
      // someone debugging a lead needs to see.
      reason: payload.reason ? `${raw}: ${payload.reason}` : raw,
      isCatchAll: payload.is_catch_all,
    };
  }
}
