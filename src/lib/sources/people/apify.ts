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
 * Apify — run someone else's scraper instead of writing ours.
 *
 * This is the entry in the spike that can make Phase 2c disappear: if a
 * marketplace actor covers team-page or directory extraction well enough, the
 * crawler never gets built. Apify's free plan includes platform credits and
 * full API access, so unlike Apollo the question here is coverage, not
 * entitlement.
 *
 * The actor is chosen by the operator via APIFY_PEOPLE_ACTOR rather than
 * hard-coded — actor quality shifts, and picking one for the user would bake
 * in a judgement the spike is supposed to make. Because each actor returns its
 * own dataset shape, field mapping below is tolerant and tries several common
 * key spellings.
 */

const BASE = "https://api.apify.com/v2";

const datasetItemSchema = z
  .object({
    name: z.string().nullable().optional(),
    fullName: z.string().nullable().optional(),
    full_name: z.string().nullable().optional(),
    firstName: z.string().nullable().optional(),
    lastName: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    jobTitle: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    headline: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    linkedinUrl: z.string().nullable().optional(),
    profileUrl: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
  })
  .loose();

const userSchema = z
  .object({
    data: z
      .object({
        username: z.string().optional(),
        plan: z
          .object({
            id: z.string().optional(),
            monthlyUsageCreditsUsd: z.number().optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export class ApifyProvider implements PeopleProvider {
  readonly key = "apify";
  readonly label = "Apify marketplace actor";
  readonly freeTierNote =
    "Free plan includes platform credits and full API access. Actor chosen via " +
    "APIFY_PEOPLE_ACTOR; a good actor here removes the need for our own crawler.";

  constructor(
    private readonly token?: string,
    private readonly actorId?: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.token && this.actorId);
  }

  async probe(): Promise<ProbeResult> {
    if (!this.token) {
      return { provider: this.key, configured: false, apiAccessible: false };
    }

    try {
      const parsed = userSchema.parse(
        await providerFetch(
          this.key,
          `${BASE}/users/me?token=${encodeURIComponent(this.token)}`,
        ),
      );

      return {
        provider: this.key,
        configured: this.isConfigured(),
        apiAccessible: true,
        planName: parsed.data?.plan?.id,
        quota: {
          limit: parsed.data?.plan?.monthlyUsageCreditsUsd,
          unit: "USD credits/month",
        },
        // Token works but no actor picked — that is an operator decision, and
        // saying so is more useful than reporting a bare failure.
        error: this.actorId
          ? undefined
          : "token valid, but APIFY_PEOPLE_ACTOR is not set — pick an actor to test coverage",
      };
    } catch (error) {
      return {
        provider: this.key,
        configured: this.isConfigured(),
        apiAccessible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async findPeople({
    domain,
    companyName,
    limit,
  }: FindPeopleInput): Promise<FoundPerson[]> {
    if (!this.token || !this.actorId) {
      throw new ProviderError(
        this.key,
        "needs both APIFY_TOKEN and APIFY_PEOPLE_ACTOR",
      );
    }

    // run-sync-get-dataset-items blocks until the run finishes and returns the
    // items directly, which keeps the harness a single call per company.
    const url =
      `${BASE}/acts/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items` +
      `?token=${encodeURIComponent(this.token)}&limit=${Math.min(limit, 100)}`;

    const raw = await providerFetch(this.key, url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Common input keys across people/company actors. Extra keys are ignored
      // by actors that don't declare them.
      body: JSON.stringify({
        domain,
        companyDomain: domain,
        companyName: companyName ?? domain,
        maxItems: limit,
        startUrls: [{ url: `https://${domain}` }],
      }),
    });

    if (!Array.isArray(raw)) {
      throw new ProviderError(
        this.key,
        `actor returned ${typeof raw}, expected a dataset array — check the actor's output shape`,
      );
    }

    return raw
      .map((item) => datasetItemSchema.safeParse(item))
      .filter((r) => r.success)
      .map((r) => r.data)
      .map((item) => {
        const fullName =
          (item.fullName ?? item.full_name ?? item.name)?.trim() ??
          [item.firstName, item.lastName].filter(Boolean).join(" ").trim();

        const title =
          (item.title ?? item.jobTitle ?? item.position ?? item.headline)?.trim() ||
          undefined;

        const first = item.firstName?.trim() || undefined;
        const last = item.lastName?.trim() || undefined;

        return {
          fullName: fullName ?? "",
          ...(first || last
            ? { firstName: first, lastName: last }
            : splitName(fullName ?? "")),
          title,
          seniority: classifySeniority(title),
          linkedinUrl: pickLinkedIn(item),
          location: item.location?.trim() || undefined,
          email: item.email?.trim() || undefined,
          provider: this.key,
        } satisfies FoundPerson;
      })
      .filter((p) => p.fullName.trim().length > 0)
      .slice(0, limit);
  }
}

function pickLinkedIn(item: z.infer<typeof datasetItemSchema>): string | undefined {
  for (const candidate of [item.linkedinUrl, item.profileUrl, item.url]) {
    const value = candidate?.trim();
    if (value && /linkedin\.com/i.test(value)) return value;
  }
  return undefined;
}
