import type { Icp } from "@/lib/icp/schema";

/**
 * People discovery — the layer Phase 2b's spike measures.
 *
 * The question this interface exists to answer: can free vendor tiers find
 * decision-makers at a company, or do we have to build a crawler? Every
 * candidate implements the same contract so the spike harness can score them
 * on equal terms, and so the winner becomes a production adapter with no
 * rewrite.
 *
 * `probe()` is separate from `findPeople()` on purpose. Several vendors offer
 * a free *plan* but gate the *API* behind a paid tier — Apollo is the clearest
 * case, with no API access below the ~$745/mo Organization plan. Probing
 * account status answers "is there an API here at all" without spending the
 * credits that the coverage test needs.
 */

export type FoundPerson = {
  fullName: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  /** Normalised bucket from `classifySeniority`, not the vendor's own label. */
  seniority?: string;
  department?: string;
  linkedinUrl?: string;
  location?: string;
  /** Present only when the provider returns an address at this step. */
  email?: string;
  /** Provider's own 0-100 score, normalised to 0-1. */
  emailConfidence?: number;
  provider: string;
};

export type ProbeResult = {
  provider: string;
  /** False when the key is absent — not a failure, just unconfigured. */
  configured: boolean;
  /** True only when a live call succeeded. This is the Apollo question. */
  apiAccessible: boolean;
  /** Free-tier allowance, when the provider reports it. */
  quota?: { used?: number; remaining?: number; limit?: number; unit?: string };
  planName?: string;
  error?: string;
};

export type FindPeopleInput = {
  domain: string;
  companyName?: string;
  icp?: Icp;
  limit: number;
};

export interface PeopleProvider {
  readonly key: string;
  readonly label: string;
  /** What the free tier is documented to allow, for the spike report. */
  readonly freeTierNote: string;

  isConfigured(): boolean;
  probe(): Promise<ProbeResult>;
  findPeople(input: FindPeopleInput): Promise<FoundPerson[]>;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

/** Shared fetch with a timeout and a provider-tagged error. */
export async function providerFetch(
  provider: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...init?.headers },
    });

    if (!response.ok) {
      // Read the body for the message — vendors put the useful part there
      // (e.g. "API access requires a paid plan"), not in the status text.
      const body = await response.text().catch(() => "");
      throw new ProviderError(
        provider,
        `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 300)}` : ""}`,
        response.status,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError(provider, `timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new ProviderError(
      provider,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export function splitName(fullName: string): {
  firstName?: string;
  lastName?: string;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
