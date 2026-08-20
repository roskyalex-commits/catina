import type { PersonSignalProvider } from "./types";

/**
 * Every person-level signal provider this build knows about.
 *
 * Empty today, and that is the honest state: no free source produces "person X
 * engaged with a post about topic Y", and nothing paid is connected yet. The
 * function exists rather than being inlined as `[]` because it is the single
 * place a bought API gets added — one `new LinkedInProvider(env.LINKEDIN_API_KEY)`
 * here, and the scan, the ledger, the scoring, the persistence and the evidence
 * link all work without another change.
 *
 * Unconfigured providers are returned rather than filtered out, matching
 * `allPeopleProviders`. The signal picker needs to distinguish "you have not
 * added a key" from "this does not exist", and collapsing the two is how a UI
 * ends up silently offering nothing.
 */

export type SignalProviderEnv = {
  /** Reserved. See PAID_PROVIDER_CATALOGUE for what would go here. */
  LINKEDIN_API_KEY?: string;
  LINKEDIN_API_BASE?: string;
};

/*
 * `env` is unread only because the list is empty. It is the seam: keeping it
 * means connecting a provider is one line below rather than a signature change
 * that ripples through every caller.
 */
export function allPersonSignalProviders(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  env: SignalProviderEnv = {},
): PersonSignalProvider[] {
  return [];
}

export function configuredPersonSignalProviders(
  env: SignalProviderEnv = {},
): PersonSignalProvider[] {
  return allPersonSignalProviders(env).filter((provider) => provider.isConfigured());
}

/** Reads the ambient environment, for callers that are not passed one. */
export function signalProviderEnv(
  source: Record<string, string | undefined> = process.env,
): SignalProviderEnv {
  return {
    LINKEDIN_API_KEY: source.LINKEDIN_API_KEY,
    LINKEDIN_API_BASE: source.LINKEDIN_API_BASE,
  };
}
