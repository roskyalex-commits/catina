import type { MailboxVerifier, VerificationVerdict } from "../mx";

/**
 * Reoon, over its REST API.
 *
 * ## Why a vendor at all
 *
 * This is the component that makes the rest of the email work shippable. The
 * waterfall's standing rule is that a pattern-generated address is never
 * returned as the sendable `email` — only a vendor or a mailbox check may
 * promote it — so without a verifier the product generates addresses and then
 * refuses to use any of them.
 *
 * A local implementation is impossible rather than merely inconvenient.
 * Mailbox-level verification needs an SMTP `RCPT TO` probe on port 25;
 * Cloudflare Workers blocks outbound 25 and its TCP sockets do not change that,
 * and essentially every residential ISP blocks it too. So the choice is a
 * vendor or nothing.
 *
 * REST rather than a client library, matching `llm/gemini.ts` — one GET, and
 * the deploy target is Workers where every dependency is bundle weight.
 *
 * ## The two modes are not interchangeable
 *
 * `power` opens an SMTP conversation and asks about the specific recipient. It
 * is the only mode that can tell a real mailbox from an invented one, and
 * therefore the only mode guess-and-verify can use.
 *
 * `quick` checks syntax, MX, disposable and spamtrap lists in under half a
 * second. Reoon's own documentation is explicit about the consequence:
 *
 *   > If the domain, syntax and a few other things are good, all emails
 *   > including non-existing ones from that domain will be marked as valid.
 *
 * So a `valid` from quick mode says "this domain can receive mail" — which we
 * already establish for free in `MxChecker`. Against a *guessed* address it is
 * worse than useless: it would confirm every guess at every live domain, and
 * `verifiesMailbox` exists to stop that at the type level rather than in a
 * comment.
 *
 * Quick mode still earns its place on addresses we already know are real — a
 * crawled `office@` can still be a spamtrap or sit on a dead domain, and
 * neither is something MX records reveal.
 */

const ENDPOINT = "https://emailverifier.reoon.com/api/v1/verify";
export type ReoonMode = "quick" | "power";
const DEFAULT_MODE: ReoonMode = "power";
/** Power mode probes a real SMTP conversation, so it is not fast. */
const POWER_TIMEOUT_MS = 45_000;
/** Quick mode is documented at well under a second; something is wrong past this. */
const QUICK_TIMEOUT_MS = 10_000;

type ReoonResponse = {
  status?: string;
  is_catch_all?: boolean;
  is_disposable?: boolean;
  is_role_account?: boolean;
  is_spamtrap?: boolean;
  mx_accepts_mail?: boolean;
  reason?: string;
  error?: string;
};

/**
 * Is this the vendor saying it is out of allowance, rather than the address
 * being bad?
 *
 * Reoon signals it with `403` and a `reason` naming credits, not the `402` a
 * reader would expect, so the status code alone is not enough to tell a billing
 * stop from a permissions problem.
 */
function isQuotaError(status: number, payload: ReoonResponse): boolean {
  if (status === 402 || status === 429) return true;
  const text = `${payload.reason ?? ""} ${payload.error ?? ""}`.toLowerCase();
  return status === 403 && /credit|quota|limit|recharge/.test(text);
}

/**
 * Both vocabularies, mapped onto ours.
 *
 * Power mode returns nine statuses, quick mode four, and they overlap only
 * partly — `valid` is quick-only and `safe` is power-only, which is a useful
 * accident: a `valid` reaching code that expected `safe` cannot be mistaken for
 * a mailbox confirmation.
 *
 * The mapping that matters is `catch_all`. A catch-all domain accepts every
 * recipient, so the probe succeeded and proved nothing — calling that
 * `verified` is precisely the mistake `mx.ts` warns about, and it is how a
 * sending domain's reputation gets spent on addresses that were never real.
 */
const STATUS_MAP: Record<string, VerificationVerdict["status"]> = {
  // --- power mode ---------------------------------------------------------
  safe: "verified",
  // Reoon reports a confirmed role mailbox under its own label rather than
  // `safe`. It still completed the check, and role addresses are the ones this
  // product prefers for Romanian outreach anyway.
  role_account: "verified",
  disabled: "invalid",
  // The mailbox exists and is bouncing. Real, but not sendable today.
  inbox_full: "risky",
  catch_all: "risky",

  // --- quick mode ---------------------------------------------------------
  /*
   * Deliberately `risky`, not `verified`.
   *
   * Quick mode marks every address at a live domain valid, so this carries no
   * information about the mailbox. `risky` is the honest reading: the domain
   * works, the recipient is unconfirmed. Anything stronger would let a caller
   * that forgot to check `verifiesMailbox` send to a guess.
   */
  valid: "risky",

  // --- both ---------------------------------------------------------------
  invalid: "invalid",
  spamtrap: "invalid",
  // Deliverable, but sending there is how a list gets flagged.
  disposable: "invalid",
  unknown: "unknown",
};

export class ReoonVerifier implements MailboxVerifier {
  readonly key = "reoon";
  readonly label = "Reoon (REOON_API_KEY)";

  private readonly apiKey?: string;
  private readonly mode: ReoonMode;
  /** Latched once the vendor reports no allowance left. */
  private exhausted = false;

  /** Blank is unset — dotenv parses `KEY=` as `""`, not undefined. */
  constructor(apiKey?: string, mode?: string) {
    this.apiKey = apiKey?.trim() || undefined;
    this.mode = mode?.trim() === "quick" ? "quick" : DEFAULT_MODE;
  }

  /** Only power mode looks at the individual inbox. See the note above. */
  get verifiesMailbox(): boolean {
    return this.mode === "power";
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /** True once the vendor has said it is out. Callers should stop the run. */
  get quotaExhausted(): boolean {
    return this.exhausted;
  }

  async verify(address: string): Promise<VerificationVerdict> {
    if (!this.apiKey) {
      return { address, status: "unknown", reason: "REOON_API_KEY is not set." };
    }

    /*
     * Do not call again once the vendor has said no. Every subsequent request
     * costs a round trip, returns the same refusal, and looks like a verdict
     * about a different address.
     */
    if (this.exhausted) {
      return {
        address,
        status: "unknown",
        reason: "Reoon reported no credits remaining; skipped without calling.",
        quotaExhausted: true,
      };
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set("email", address);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("mode", this.mode);

    const timeout = this.mode === "quick" ? QUICK_TIMEOUT_MS : POWER_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let payload: ReoonResponse;
    try {
      const response = await fetch(url, { signal: controller.signal });
      payload = (await response.json().catch(() => ({}))) as ReoonResponse;

      if (!response.ok) {
        /*
         * The vendor's own quota is the truth; our ledger is an estimate.
         *
         * `CreditLedger` counts one credit per call against a limit we wrote
         * down from documentation. Reoon began answering
         * `403 {"reason":"Not enough credits available"}` while that estimate
         * still read 366 of 600 — so either the free tier is smaller than
         * documented or a power-mode check costs more than one. Either way the
         * local number was wrong and kept authorising calls.
         *
         * Latching here is what makes that survivable. Without it a bulk run
         * makes hundreds of failing HTTP calls, maps each to `unknown`, and
         * reports "0 verified" — which reads exactly like every address being
         * bad. That happened: 198 calls after exhaustion, on a segment whose
         * addresses were never actually checked.
         */
        if (isQuotaError(response.status, payload)) {
          this.exhausted = true;
        }
        /*
         * `unknown`, not `invalid`. An exhausted quota or a bad key says
         * nothing about the address, and returning `invalid` would let a
         * billing problem quietly delete every candidate it touched.
         */
        return {
          address,
          status: "unknown",
          reason: payload.error ?? payload.reason ?? `${response.status} ${response.statusText}`,
          quotaExhausted: this.exhausted,
        };
      }
    } catch (error) {
      return {
        address,
        status: "unknown",
        reason:
          error instanceof Error && error.name === "AbortError"
            ? `Reoon did not answer within ${timeout / 1000}s.`
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
      // The vendor's own word and the mode, kept verbatim: `catch_all` and
      // `disabled` both map to statuses that hide which one happened, and a
      // `valid` needs its mode attached or it reads like a confirmation.
      reason: `${this.mode}/${raw}${payload.reason ? `: ${payload.reason}` : ""}`,
      isCatchAll: payload.is_catch_all,
    };
  }
}
