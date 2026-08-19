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
 * Prospeo — domain search.
 *
 * Worth a slot in the spike specifically because independent benchmarks put it
 * and Dropcontact ahead of the US-centric tools on European lists, which is
 * the half of coverage that matters most here.
 *
 * SHAPE UNVERIFIED: the request and response below follow Prospeo's documented
 * domain-search endpoint, but no live call was made when this was written
 * (the authoring environment had no egress). Parsing is defensive and the spike
 * harness prints the raw payload on a parse failure, so a mismatch is a
 * one-file fix rather than a silent zero.
 */

const BASE = "https://api.prospeo.io";

const personSchema = z
  .object({
    email: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    full_name: z.string().nullable().optional(),
    job_title: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    linkedin_url: z.string().nullable().optional(),
    email_status: z.string().nullable().optional(),
  })
  .loose();

const domainSearchSchema = z
  .object({
    error: z.boolean().optional(),
    message: z.string().optional(),
    response: z
      .object({
        email_list: z.array(personSchema).default([]),
      })
      .loose()
      .optional(),
  })
  .loose();

const accountSchema = z
  .object({
    error: z.boolean().optional(),
    response: z
      .object({
        remaining_credits: z.number().optional(),
        plan: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export class ProspeoProvider implements PeopleProvider {
  readonly key = "prospeo";
  readonly label = "Prospeo domain search";
  readonly freeTierNote =
    "Free credits on signup; strong on European lists. Endpoint shape not yet " +
    "verified against a live call.";

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "X-KEY": this.apiKey as string,
    };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey) {
      return { provider: this.key, configured: false, apiAccessible: false };
    }

    try {
      const raw = await providerFetch(this.key, `${BASE}/account-information`, {
        method: "POST",
        headers: this.headers(),
      });
      const parsed = accountSchema.parse(raw);

      return {
        provider: this.key,
        configured: true,
        apiAccessible: parsed.error !== true,
        planName: parsed.response?.plan,
        quota: {
          remaining: parsed.response?.remaining_credits,
          unit: "credits",
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

    const raw = await providerFetch(this.key, `${BASE}/domain-search`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ company: domain, limit: Math.min(limit, 100) }),
    });

    const parsed = domainSearchSchema.parse(raw);
    if (parsed.error) {
      throw new ProviderError(this.key, parsed.message ?? "provider reported an error");
    }

    return (parsed.response?.email_list ?? [])
      .map((entry) => {
        const explicitName = entry.full_name?.trim();
        const first = entry.first_name?.trim() || undefined;
        const last = entry.last_name?.trim() || undefined;
        const composed = [first, last].filter(Boolean).join(" ");
        const fullName = explicitName || composed;
        const title = (entry.job_title ?? entry.position)?.trim() || undefined;

        const nameParts =
          first || last ? { firstName: first, lastName: last } : splitName(fullName);

        return {
          fullName,
          ...nameParts,
          title,
          seniority: classifySeniority(title),
          linkedinUrl: entry.linkedin_url?.trim() || undefined,
          email: entry.email?.trim() || undefined,
          // Prospeo reports a status string rather than a score; treat a
          // verified address as high confidence and anything else as unknown.
          emailConfidence:
            entry.email_status?.toLowerCase() === "valid" ? 0.95 : undefined,
          provider: this.key,
        } satisfies FoundPerson;
      })
      .filter((p) => p.fullName.trim().length > 0)
      .slice(0, limit);
  }
}
