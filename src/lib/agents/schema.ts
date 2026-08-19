import { z } from "zod";
import { icpSchema } from "@/lib/icp/schema";
import { SIGNAL_SOURCE_CATALOGUE } from "@/lib/signals/scanner";

/**
 * What the onboarding wizard sends to `POST /api/v1/agents`.
 *
 * Built from `icpSchema` rather than restating it: the wizard already holds a
 * corrected `Icp` and posts it back unchanged, so the two cannot drift. Only
 * the fields the ICP has no opinion about are added here — the agent's name,
 * the site it was inferred from, and which signal sources it subscribes to.
 */

const SIGNAL_KEYS = SIGNAL_SOURCE_CATALOGUE.map((entry) => entry.key);

/**
 * Signals default to the free, no-key sources. The metered ones stay off until
 * the user turns them on, so a new agent cannot spend vendor credits on its
 * first run without anyone having asked for it.
 */
export const DEFAULT_ENABLED_SIGNALS = [
  "anaf_growth",
  "anaf_status",
  "hiring",
  "tech_stack",
] as const;

export const createAgentSchema = icpSchema.extend({
  name: z.string().trim().min(1).max(80),
  websiteUrl: z.string().trim().min(3).max(2048),
  /**
   * Validated against the catalogue, not left open: an unknown key would sit
   * in the column silently and the scanner would never run it.
   */
  enabledSignals: z
    .array(z.string())
    .max(SIGNAL_KEYS.length)
    .default([...DEFAULT_ENABLED_SIGNALS])
    .refine(
      (keys) => keys.every((key) => SIGNAL_KEYS.includes(key)),
      { message: "Unknown signal source." },
    ),
});

export type CreateAgentInput = z.infer<typeof createAgentSchema>;
