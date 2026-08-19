import { z } from "zod";

/**
 * Domain deliverability checks over DNS-over-HTTPS.
 *
 * DoH rather than a DNS library because the app runs on Cloudflare Workers,
 * which has no UDP and therefore no conventional resolver. DoH is plain HTTPS,
 * so it works in the same runtime as everything else.
 *
 * What this can and cannot establish:
 *   - no MX records  -> the domain accepts no mail at all; every candidate for
 *     it is dead, which is worth knowing before spending a vendor credit
 *   - MX present      -> the domain accepts mail. It says nothing about whether
 *     a specific mailbox exists.
 *
 * Mailbox-level checks need an SMTP RCPT probe on port 25, which Cloudflare
 * Workers cannot make — outbound 25 is blocked and Workers' TCP sockets do not
 * change that. So per-address verification is deliberately behind the
 * `MailboxVerifier` interface below rather than implemented here: it needs
 * either a separate long-running worker or a vendor with a verification
 * endpoint. Treating a pattern-generated address as verified because its
 * domain has MX records would be the most expensive mistake in this file.
 */

const dohAnswerSchema = z
  .object({
    Status: z.number().optional(),
    Answer: z
      .array(
        z
          .object({
            name: z.string().optional(),
            type: z.number().optional(),
            data: z.string().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

const MX_RECORD_TYPE = 15;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 8_000;

/** Free public mailbox providers — an address here proves nothing about a company. */
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com",
  // Romanian consumer providers, still in wide use for small businesses.
  "yahoo.ro", "gmail.ro", "mail.ru", "rdslink.ro", "clicknet.ro",
]);

export type MxResult = {
  domain: string;
  /** True when the domain publishes at least one MX record. */
  acceptsMail: boolean;
  hosts: string[];
  /** Detected provider, useful for send-time deliverability decisions. */
  provider?: "google" | "microsoft" | "zoho" | "other";
  /** True when the domain is a consumer mailbox provider, not a company. */
  isFreeProvider: boolean;
  /** Set when the lookup itself failed — distinct from "no MX records". */
  error?: string;
};

export type CacheLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export class MxChecker {
  constructor(
    private readonly cache?: CacheLike,
    private readonly ttlSeconds = 60 * 60 * 24 * 7,
  ) {}

  async check(rawDomain: string): Promise<MxResult> {
    const domain = rawDomain.trim().toLowerCase().replace(/^www\./, "");

    if (!domain.includes(".")) {
      return {
        domain,
        acceptsMail: false,
        hosts: [],
        isFreeProvider: false,
        error: "not a domain",
      };
    }

    if (FREE_MAIL_DOMAINS.has(domain)) {
      // Short-circuit: these always accept mail, and a lookup teaches nothing.
      return {
        domain,
        acceptsMail: true,
        hosts: [],
        isFreeProvider: true,
        provider: "other",
      };
    }

    const cacheKey = `mx:${domain}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as MxResult;
      } catch {
        // Corrupt entry — fall through and re-resolve.
      }
    }

    const result = await this.resolve(domain);

    // Only cache determinate answers. Caching a transient lookup failure for a
    // week would permanently blank a domain that is actually fine.
    if (!result.error) {
      await this.cache?.put(cacheKey, JSON.stringify(result), {
        expirationTtl: this.ttlSeconds,
      });
    }
    return result;
  }

  private async resolve(domain: string): Promise<MxResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(
        `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=MX`,
        { headers: { accept: "application/dns-json" }, signal: controller.signal },
      );

      if (!response.ok) {
        return {
          domain,
          acceptsMail: false,
          hosts: [],
          isFreeProvider: false,
          error: `resolver returned ${response.status}`,
        };
      }

      const parsed = dohAnswerSchema.parse(await response.json());
      const hosts = (parsed.Answer ?? [])
        .filter((a) => a.type === MX_RECORD_TYPE && a.data)
        // DoH returns "10 aspmx.l.google.com." — drop the priority and the
        // trailing root dot.
        .map((a) => (a.data as string).split(/\s+/).pop() ?? "")
        .map((h) => h.replace(/\.$/, "").toLowerCase())
        .filter(Boolean);

      return {
        domain,
        acceptsMail: hosts.length > 0,
        hosts,
        isFreeProvider: false,
        provider: detectProvider(hosts),
      };
    } catch (error) {
      return {
        domain,
        acceptsMail: false,
        hosts: [],
        isFreeProvider: false,
        error:
          error instanceof Error && error.name === "AbortError"
            ? "resolver timed out"
            : error instanceof Error
              ? error.message
              : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function detectProvider(hosts: string[]): MxResult["provider"] {
  const joined = hosts.join(" ");
  if (/google|googlemail/.test(joined)) return "google";
  if (/outlook|microsoft|office365|protection\.outlook/.test(joined)) {
    return "microsoft";
  }
  if (/zoho/.test(joined)) return "zoho";
  return hosts.length > 0 ? "other" : undefined;
}

/**
 * Per-mailbox verification.
 *
 * Not implemented on Workers — see the note at the top of this file. The
 * interface exists so the waterfall can call it when a verifier is available
 * (a vendor endpoint, or a separate runtime that can open port 25) without the
 * waterfall itself needing to change.
 */
export interface MailboxVerifier {
  readonly key: string;
  verify(address: string): Promise<{
    address: string;
    status: "verified" | "risky" | "invalid" | "unknown";
    reason?: string;
  }>;
}
