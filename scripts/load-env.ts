/**
 * Environment loading for the ops scripts.
 *
 * Import this rather than `dotenv/config`.
 *
 * `dotenv/config` reads `.env` and nothing else, but the setup instructions —
 * and Next.js itself — use `.env.local`. Following the README exactly therefore
 * produced "DATABASE_URL is not set" from a script whose own error message told
 * you to put it in `.env.local`, where you had just put it.
 *
 * Order matches Next.js: `.env.local` wins, `.env` is the fallback. dotenv does
 * not override an already-set key, so listing the local file first gives it
 * precedence, and a variable exported in the real shell still beats both.
 */
import { config } from "dotenv";

config({ path: [".env.local", ".env"] });

/**
 * Read a required variable, or exit with an actionable message.
 *
 * Exits rather than throws: these are CLIs, and a stack trace pointing into
 * dotenv tells the reader nothing about which line of which file to fill in.
 */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is not set. Add it to .env.local (copy .env.example if you have not yet).` +
        (hint ? `\n  ${hint}` : ""),
    );
    process.exit(1);
  }
  return value;
}
