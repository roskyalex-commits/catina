import { z } from "zod";

/**
 * Environment contract.
 *
 * Split into three schemas because they are available in different places:
 * - `publicEnv` is inlined into the browser bundle at build time.
 * - `serverEnv` is read from `process.env` in Node contexts (scripts, migrations).
 * - `workerEnv` is read from the Cloudflare Workers binding object, which is
 *   passed per-request and is NOT on `process.env`.
 *
 * Every provider key is optional on purpose: the MVP must boot and be useful
 * with none of them set. An adapter whose key is missing reports itself
 * unavailable and the waterfall skips it (see `src/lib/enrichment/`).
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),
});

const secretSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /** Postgres connection string — migrations only, never used at runtime. */
  DATABASE_URL: z.string().min(1).optional(),

  /**
   * Optional, like every other provider key above and below.
   *
   * It was required, which made `getEnv()` throw for callers that have nothing
   * to do with Claude — `createSupabaseAdminClient()` among them, so signup
   * bootstrap 500'd with "missing ANTHROPIC_API_KEY" while creating a
   * workspace. Env validation must not couple unrelated subsystems; the two
   * routes that actually need this key check for it and say so.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /**
   * The other model that can fill the ICP schema.
   *
   * Optional and second in preference, but not an afterthought: Gemini has a
   * usable free tier, and the ICP analysis is the first screen a new user sees.
   * "You need a paid account before this does anything" is a poor opening for a
   * product whose pitch is that its data sources cost nothing.
   */
  GEMINI_API_KEY: z.string().min(1).optional(),
  /** Override the default `gemini-2.5-flash`. */
  GEMINI_MODEL: z.string().min(1).optional(),

  /** 32-byte base64 key for AES-GCM encryption of OAuth refresh tokens. */
  ENCRYPTION_KEY: z.string().min(1),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Enrichment providers — all optional, all free-tier candidates (plan §6).
  HUNTER_API_KEY: z.string().optional(),
  PDL_API_KEY: z.string().optional(),
  PROSPEO_API_KEY: z.string().optional(),
  LEADMAGIC_API_KEY: z.string().optional(),
  CORESIGNAL_API_KEY: z.string().optional(),
  APIFY_TOKEN: z.string().optional(),
  /** Which Apify marketplace actor to run; a token alone finds nobody. */
  APIFY_PEOPLE_ACTOR: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
});

const fullSchema = publicSchema.extend(secretSchema.shape);

export type PublicEnv = z.infer<typeof publicSchema>;
export type SecretEnv = z.infer<typeof secretSchema>;
export type AppEnv = z.infer<typeof fullSchema>;

/**
 * Drop empty values so `KEY=` in a .env file means "not set".
 *
 * dotenv parses a blank assignment as `""`, not `undefined`. That defeats
 * `.optional()` — an optional string still fails `.min(1)` when it is present
 * and empty — so a commented-out-by-blanking key read as a *malformed* key
 * rather than an absent one. `.env.example` ships with eight such lines, so
 * every fresh setup starts in exactly that state.
 *
 * Normalising here rather than per-field keeps the schemas readable and applies
 * the same rule to every variable, including the provider keys that are meant
 * to be blank until someone signs up for them.
 */
function present(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => !(typeof value === "string" && value.trim() === ""),
    ),
  );
}

/**
 * Public vars must be referenced as literal `process.env.X` so the Next.js
 * bundler can inline them; a dynamic lookup would yield undefined in the browser.
 */
export function getPublicEnv(): PublicEnv {
  return publicSchema.parse(
    present({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    }),
  );
}

/**
 * Resolve the full env from a Cloudflare Workers binding object when present,
 * falling back to `process.env` for local dev, scripts and migrations.
 */
export function getEnv(bindings?: Record<string, unknown>): AppEnv {
  const source = present({ ...process.env, ...(bindings ?? {}) });
  const result = fullSchema.safeParse(source);

  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Invalid or missing environment variables: ${missing}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return result.data;
}

/**
 * Is a database configured?
 *
 * This is what "demo mode" turns on, and it deliberately asks a narrower
 * question than `describeEnv().valid`. Demo mode exists because there may be no
 * Supabase project — not because some unrelated key is missing. Keying it off
 * the full schema meant an absent `ANTHROPIC_API_KEY` kept the whole app on
 * fixtures even with a real database attached, which contradicted the README
 * and looked like the signup had silently failed.
 *
 * Matches `src/proxy.ts`, which gates on exactly these two values.
 */
export function isDatabaseConfigured(bindings?: Record<string, unknown>): boolean {
  const source = present({ ...process.env, ...(bindings ?? {}) });
  return publicSchema.safeParse(source).success;
}

/** Non-throwing check, for a startup diagnostics page. */
export function describeEnv(bindings?: Record<string, unknown>) {
  const source = present({ ...process.env, ...(bindings ?? {}) });
  const parsed = fullSchema.safeParse(source);
  const optionalKeys = [
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_CLIENT_ID",
    "HUNTER_API_KEY",
    "PDL_API_KEY",
    "PROSPEO_API_KEY",
    "LEADMAGIC_API_KEY",
    "CORESIGNAL_API_KEY",
    "APIFY_TOKEN",
    "APIFY_PEOPLE_ACTOR",
    "BRAVE_SEARCH_API_KEY",
  ] as const;

  return {
    valid: parsed.success,
    missingRequired: parsed.success
      ? []
      : parsed.error.issues.map((i) => i.path.join(".")),
    configuredProviders: optionalKeys.filter((k) => Boolean(source[k])),
  };
}
