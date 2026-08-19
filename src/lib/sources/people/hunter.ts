import { z } from "zod";
import { classifySeniority } from "./seniority";
import {
  type FindPeopleInput,
  type FoundPerson,
  type PeopleProvider,
  type ProbeResult,
  ProviderError,
  providerFetch,
  splitName,
} from "./types";

/**
 * Hunter.io — domain search.
 *
 * The most likely winner of the spike for the international set: its free plan
 * has historically included API access (unlike Apollo's), and domain-search
 * returns name, position and a confidence-scored email in one call, which is
 * both halves of what we need.
 *
 * Free-tier allowance changes; `probe()` reads it from /v2/account rather than
 * hard-coding a number the docs may have moved.
 */

const BASE = "https://api.hunter.io/v2";

const emailSchema = z
  .object({
    value: z.string().optional(),
    type: z.string().optional(),
    confidence: z.number().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
  })
  .loose();

const domainSearchSchema = z
  .object({
    data: z
      .object({
        domain: z.string().optional(),
        organization: z.string().nullable().optional(),
        emails: z.array(emailSchema).default([]),
      })
      .loose()
      .optional(),
    meta: z.object({ results: z.number().optional() }).loose().optional(),
  })
  .loose();

const accountSchema = z
  .object({
    data: z
      .object({
        plan_name: z.string().optional(),
        requests: z
          .object({
            searches: z
              .object({
                used: z.number().optional(),
                available: z.number().optional(),
              })
              .loose()
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export class HunterProvider implements PeopleProvider {
  readonly key = "hunter";
  readonly label = "Hunter.io domain search";
  readonly freeTierNote =
    "Free plan documented to include API access with a monthly search " +
    "allowance; probe() reads the live figure.";

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey) {
      return { provider: this.key, configured: false, apiAccessible: false };
    }

    try {
      const raw = await providerFetch(
        this.key,
        `${BASE}/account?api_key=${encodeURIComponent(this.apiKey)}`,
      );
      const parsed = accountSchema.parse(raw);
      const searches = parsed.data?.requests?.searches;

      return {
        provider: this.key,
        configured: true,
        apiAccessible: true,
        planName: parsed.data?.plan_name,
        quota: {
          used: searches?.used,
          limit: searches?.available,
          remaining:
            searches?.available !== undefined && searches?.used !== undefined
              ? searches.available - searches.used
              : undefined,
          unit: "searches/month",
        },
      };
    } catch (error) {
      return {
        provider: this.key,
        configured: true,
        apiAccessible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async findPeople({ domain, limit }: FindPeopleInput): Promise<FoundPerson[]> {
    if (!this.apiKey) throw new ProviderError(this.key, "no API key configured");

    const url =
      `${BASE}/domain-search?domain=${encodeURIComponent(domain)}` +
      `&limit=${Math.min(limit, 100)}&api_key=${encodeURIComponent(this.apiKey)}`;

    const parsed = domainSearchSchema.parse(await providerFetch(this.key, url));
    const emails = parsed.data?.emails ?? [];

    return emails
      .filter((e) => e.value)
      // Role addresses (office@, contact@) carry no person, so they are not
      // people-coverage. Phase 3's waterfall picks them up separately — they
      // are the RO-defensible contact route.
      .filter((e) => e.type !== "generic")
      .map((e) => {
        const first = e.first_name?.trim() || undefined;
        const last = e.last_name?.trim() || undefined;
        const fullName = [first, last].filter(Boolean).join(" ");
        const title = e.position?.trim() || undefined;

        return {
          fullName: fullName || (e.value as string),
          firstName: first,
          lastName: last,
          title,
          seniority: classifySeniority(title),
          department: e.department?.trim() || undefined,
          linkedinUrl: e.linkedin?.trim() || undefined,
          email: e.value,
          // Hunter scores 0-100; the interface is 0-1.
          emailConfidence:
            typeof e.confidence === "number" ? e.confidence / 100 : undefined,
          provider: this.key,
        } satisfies FoundPerson;
      })
      .filter((p) => p.fullName.trim().length > 0)
      .slice(0, limit);
  }
}

export { splitName };
