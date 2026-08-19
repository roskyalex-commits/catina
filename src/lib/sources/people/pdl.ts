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
 * People Data Labs — person search.
 *
 * In the spike for coverage breadth, not for contactability: PDL returns rich
 * person records but not verified business emails, so a win here still needs
 * Phase 3's waterfall on top. Its self-serve pricing (~$0.28/record) rules it
 * out as a paid backbone, which makes the free tier the only question.
 *
 * SHAPE PARTIALLY VERIFIED: the v5 person/search contract (Elasticsearch-style
 * `query`, `X-Api-Key` header, `{status, data[], total}` envelope) is stable
 * and coded precisely; the exact free-tier quota fields are not, so `probe()`
 * infers accessibility from a minimal search rather than an account endpoint.
 */

const BASE = "https://api.peopledatalabs.com/v5";

const personSchema = z
  .object({
    full_name: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    job_title: z.string().nullable().optional(),
    job_title_role: z.string().nullable().optional(),
    job_company_name: z.string().nullable().optional(),
    linkedin_url: z.string().nullable().optional(),
    location_name: z.string().nullable().optional(),
    work_email: z.string().nullable().optional(),
  })
  .loose();

const searchSchema = z
  .object({
    status: z.number().optional(),
    data: z.array(personSchema).default([]),
    total: z.number().optional(),
    error: z
      .object({ type: z.string().optional(), message: z.unknown().optional() })
      .loose()
      .optional(),
  })
  .loose();

export class PdlProvider implements PeopleProvider {
  readonly key = "pdl";
  readonly label = "People Data Labs person search";
  readonly freeTierNote =
    "Free tier exists but is small; no verified emails, so a win here still " +
    "needs the Phase 3 waterfall on top.";

  constructor(private readonly apiKey?: string) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * PDL has no cheap account endpoint, so accessibility is probed with the
   * smallest possible search (size 1) against a domain guaranteed to exist.
   * That costs one credit — cheaper than discovering mid-spike that the key
   * has no API entitlement.
   */
  async probe(): Promise<ProbeResult> {
    if (!this.apiKey) {
      return { provider: this.key, configured: false, apiAccessible: false };
    }

    try {
      const raw = await this.search("anthropic.com", 1);
      const parsed = searchSchema.parse(raw);
      return {
        provider: this.key,
        configured: true,
        apiAccessible: parsed.error === undefined,
        quota: { unit: "records" },
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

  private async search(domain: string, size: number): Promise<unknown> {
    const query = {
      bool: {
        must: [{ term: { job_company_website: domain } }],
      },
    };

    const url =
      `${BASE}/person/search?query=${encodeURIComponent(JSON.stringify(query))}` +
      `&size=${size}`;

    return providerFetch(this.key, url, {
      headers: { "X-Api-Key": this.apiKey as string },
    });
  }

  async findPeople({ domain, limit }: FindPeopleInput): Promise<FoundPerson[]> {
    if (!this.apiKey) throw new ProviderError(this.key, "no API key configured");

    const parsed = searchSchema.parse(
      await this.search(domain, Math.min(limit, 100)),
    );

    if (parsed.error) {
      throw new ProviderError(
        this.key,
        `search rejected: ${JSON.stringify(parsed.error).slice(0, 200)}`,
      );
    }

    return parsed.data
      .map((entry) => {
        const fullName = entry.full_name?.trim() ?? "";
        const title = entry.job_title?.trim() || undefined;
        const first = entry.first_name?.trim() || undefined;
        const last = entry.last_name?.trim() || undefined;

        return {
          fullName,
          ...(first || last
            ? { firstName: first, lastName: last }
            : splitName(fullName)),
          title,
          seniority: classifySeniority(title),
          department: entry.job_title_role?.trim() || undefined,
          linkedinUrl: normaliseLinkedIn(entry.linkedin_url),
          location: entry.location_name?.trim() || undefined,
          // PDL returns work_email only on higher tiers; never assume it.
          email: entry.work_email?.trim() || undefined,
          provider: this.key,
        } satisfies FoundPerson;
      })
      .filter((p) => p.fullName.length > 0)
      .slice(0, limit);
  }
}

/** PDL returns bare paths like "linkedin.com/in/x" as often as full URLs. */
function normaliseLinkedIn(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
