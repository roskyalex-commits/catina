import type { MailboxVerifier } from "../mx";
import { ReoonVerifier } from "./reoon";

/**
 * Which mailbox verifier runs, if any.
 *
 * Mirrors `src/lib/llm/registry.ts` deliberately: same preference-order shape,
 * same blank-is-unset rule, same "list the unconfigured ones too so a setup
 * screen can name them". A second registry with different conventions is a
 * second set of surprises.
 *
 * One provider today. The registry exists anyway because the alternative is a
 * `new ReoonVerifier(...)` scattered across the enrichment path, and the choice
 * of verifier is exactly the kind of thing that changes when a free tier runs
 * out mid-month.
 */

export type VerifierEnv = {
  REOON_API_KEY?: string;
};

export function allVerifiers(env: VerifierEnv): MailboxVerifier[] {
  return [new ReoonVerifier(env.REOON_API_KEY)];
}

/** Configured providers, in preference order. */
export function configuredVerifiers(env: VerifierEnv): MailboxVerifier[] {
  return allVerifiers(env).filter((verifier) => verifier.isConfigured());
}

/**
 * The one to use, or null when none is configured.
 *
 * Null is a supported state, not an error: the waterfall runs without a
 * verifier and simply never promotes a guess past `pattern`. That is the
 * correct behaviour for a workspace that has not set a key — degraded, and
 * honest about it.
 */
export function preferredVerifier(env: VerifierEnv): MailboxVerifier | null {
  return configuredVerifiers(env)[0] ?? null;
}
