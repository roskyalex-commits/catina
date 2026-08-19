import { ApifyProvider } from "./apify";
import { HunterProvider } from "./hunter";
import { PdlProvider } from "./pdl";
import { ProspeoProvider } from "./prospeo";
import type { PeopleProvider } from "./types";

export type ProviderEnv = {
  HUNTER_API_KEY?: string;
  PROSPEO_API_KEY?: string;
  PDL_API_KEY?: string;
  APIFY_TOKEN?: string;
  APIFY_PEOPLE_ACTOR?: string;
};

/**
 * Every people provider the spike knows about, configured or not.
 *
 * Unconfigured providers are returned rather than filtered out, so the spike
 * report distinguishes "we tested it and it was thin" from "we never had a
 * key" — collapsing those two is how a spike ends up recommending a crawler it
 * did not need.
 *
 * Apollo is deliberately absent: its free and Basic plans include no API
 * access at all, and API starts at the ~$745/mo Organization tier, so there is
 * nothing here for a zero-cost MVP to test.
 */
export function allPeopleProviders(env: ProviderEnv): PeopleProvider[] {
  return [
    new HunterProvider(env.HUNTER_API_KEY),
    new ProspeoProvider(env.PROSPEO_API_KEY),
    new PdlProvider(env.PDL_API_KEY),
    new ApifyProvider(env.APIFY_TOKEN, env.APIFY_PEOPLE_ACTOR),
  ];
}

export function configuredPeopleProviders(env: ProviderEnv): PeopleProvider[] {
  return allPeopleProviders(env).filter((p) => p.isConfigured());
}
