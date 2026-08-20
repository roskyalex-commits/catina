import { AnthropicExtractor } from "./anthropic";
import { GeminiExtractor } from "./gemini";
import type { StructuredExtractor } from "./types";

/**
 * Which model fills the schema, and in what order.
 *
 * Claude first when its key is present — it is measurably better at a fifteen
 * field extraction over a long page dump, and `zodOutputFormat` constrains it
 * with the exact schema the app validates against. Gemini second, because its
 * free tier means the product's first screen works for someone who has not paid
 * anyone yet.
 *
 * Ordered, not chosen by a setting. A "preferred provider" dropdown would be a
 * decision the user has no basis for making, and a fallback that only triggers
 * on an outage is a code path that never runs until the day it matters.
 */

export type LlmEnv = {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** Override the Gemini model, e.g. to move off Flash. */
  GEMINI_MODEL?: string;
};

export function allExtractors(env: LlmEnv): StructuredExtractor[] {
  return [
    new AnthropicExtractor(env.ANTHROPIC_API_KEY),
    new GeminiExtractor(env.GEMINI_API_KEY, env.GEMINI_MODEL),
  ];
}

/** Every provider with a key, in preference order. */
export function configuredExtractors(env: LlmEnv): StructuredExtractor[] {
  return allExtractors(env).filter((extractor) => extractor.isConfigured());
}

/** The one that will run, or null when nothing is configured. */
export function preferredExtractor(env: LlmEnv): StructuredExtractor | null {
  return configuredExtractors(env)[0] ?? null;
}

/**
 * What to tell someone with no key set.
 *
 * Names both options and says which is free, because the previous message named
 * only Anthropic — and a user who has a Gemini key sitting in a tab would have
 * had no way of knowing it was worth pasting.
 */
export const NO_LLM_CONFIGURED =
  "This needs a model key. Set either ANTHROPIC_API_KEY or GEMINI_API_KEY in " +
  ".env.local and restart the dev server — Gemini has a free tier, so it is " +
  "the quicker way to try it. Everything else in the app, including sourcing, " +
  "signals and scoring, runs without one.";
