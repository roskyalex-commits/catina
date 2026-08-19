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

  ANTHROPIC_API_KEY: z.string().min(1),

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
  BRAVE_SEARCH_API_KEY: z.string().optional(),
});

const fullSchema = publicSchema.extend(secretSchema.shape);

export type PublicEnv = z.infer<typeof publicSchema>;
export type SecretEnv = z.infer<typeof secretSchema>;
export type AppEnv = z.infer<typeof fullSchema>;

/**
 * Public vars must be referenced as literal `process.env.X` so the Next.js
 * bundler can inline them; a dynamic lookup would yield undefined in the browser.
 */
export function getPublicEnv(): PublicEnv {
  return publicSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });
}

/**
 * Resolve the full env from a Cloudflare Workers binding object when present,
 * falling back to `process.env` for local dev, scripts and migrations.
 */
export function getEnv(bindings?: Record<string, unknown>): AppEnv {
  const source = { ...process.env, ...(bindings ?? {}) };
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

/** Non-throwing check, for a startup diagnostics page. */
export function describeEnv(bindings?: Record<string, unknown>) {
  const source = { ...process.env, ...(bindings ?? {}) };
  const parsed = fullSchema.safeParse(source);
  const optionalKeys = [
    "GOOGLE_CLIENT_ID",
    "HUNTER_API_KEY",
    "PDL_API_KEY",
    "PROSPEO_API_KEY",
    "LEADMAGIC_API_KEY",
    "CORESIGNAL_API_KEY",
    "APIFY_TOKEN",
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
