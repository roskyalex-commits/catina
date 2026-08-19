import type { SupabaseClient } from "@supabase/supabase-js";
import {
  optionalDate,
  optionalNumber,
  optionalString,
  requireString,
} from "@/lib/supabase/row";
import { SIGNAL_HALF_LIFE_DAYS, type Signal, type SignalType } from "./types";

/**
 * The only place that maps `Signal` to the `signals` table and back.
 *
 * Both halves of the loop go through here — the scanner writing what it found,
 * and the sourcing run reading it back to score with. Keeping them in one file
 * is what makes the dedupe-key scoping below impossible to forget.
 */

/** One literal: supabase-js reads this at the type level and `"a" + "b"` widens. */
export const SIGNAL_COLUMNS =
  "id, company_id, person_id, type, title, payload, evidence_url, strength, detected_at, dedupe_key";

const SIGNAL_TYPES = new Set<string>(Object.keys(SIGNAL_HALF_LIFE_DAYS));

/**
 * Scope a source's natural key to one company.
 *
 * `signals_dedupe_idx` is UNIQUE on `dedupe_key` alone, **globally**. Most
 * sources embed a domain or a CUI and so are unique by accident; the news
 * source embeds only the article guid, so a single article naming two companies
 * would have the second upsert steal the first company's row — silently, and
 * only in production, because no test scans two companies from one article.
 *
 * Scoping every key here makes the index per-company by construction and costs
 * the sources nothing. Do not push this responsibility back down into them:
 * the whole point is that a source author cannot get it wrong.
 */
export function scopedDedupeKey(companyId: string, key: string): string {
  return `${companyId}:${key}`;
}

/** Map a row back to a `Signal`, or null when it is unusable. */
export function signalFrom(row: Record<string, unknown>): Signal | null {
  const type = optionalString(row.type);
  // A type this build does not know decays by an unknown half-life, so it
  // cannot be scored. Dropping it is better than defaulting the decay.
  if (!type || !SIGNAL_TYPES.has(type)) return null;

  const detectedAt = optionalDate(row.detected_at);
  if (!detectedAt) return null;

  return {
    type: type as SignalType,
    title: optionalString(row.title) ?? type,
    evidenceUrl: optionalString(row.evidence_url) ?? undefined,
    strength: optionalNumber(row.strength) ?? 0.5,
    detectedAt,
    dedupeKey: requireString(row.dedupe_key, "dedupe_key"),
    payload: (row.payload as Record<string, unknown>) ?? undefined,
  };
}

const ID_CHUNK = 200;
const PAGE = 1000;
/** Older than this contributes ~nothing after decay and only clutters the breakdown. */
const DEFAULT_MAX_AGE_DAYS = 400;

/**
 * Signals for these companies, keyed by company.
 *
 * Chunked and paged deliberately: PostgREST caps a select at 1,000 rows with no
 * error and no truncation flag, and a rescore across 900 leads would quietly
 * read a fraction of them — the same failure that made an earlier enrichment run
 * report success having touched a tenth of the data.
 */
export async function findSignalsFor(
  db: SupabaseClient,
  companyIds: string[],
  options: { maxAgeDays?: number } = {},
): Promise<Map<string, Signal[]>> {
  const byCompany = new Map<string, Signal[]>();
  if (companyIds.length === 0) return byCompany;

  const since = new Date(
    Date.now() - (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000,
  ).toISOString();

  const unique = [...new Set(companyIds)];
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const chunk = unique.slice(i, i + ID_CHUNK);

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from("signals")
        .select(SIGNAL_COLUMNS)
        .in("company_id", chunk)
        .gte("detected_at", since)
        .order("detected_at", { ascending: false })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error("Reading signals failed:", error.message);
        return byCompany;
      }

      const rows = (data ?? []) as Record<string, unknown>[];
      for (const row of rows) {
        const companyId = optionalString(row.company_id);
        const signal = signalFrom(row);
        if (!companyId || !signal) continue;
        byCompany.set(companyId, [...(byCompany.get(companyId) ?? []), signal]);
      }
      if (rows.length < PAGE) break;
    }
  }

  return byCompany;
}

export type UpsertSignalsResult = { written: number; error?: string };

/**
 * Write a scan's signals for one company.
 *
 * Service role only: `signals` is shared reference data with no insert policy
 * for `authenticated` (see `drizzle/policies.sql`), so a request-scoped client
 * writes nothing here and says so with no error.
 *
 * Upserts on `dedupe_key` so a rescan updates rather than duplicates — which is
 * the entire reason sources are required to produce a stable natural key.
 */
export async function upsertSignals(
  admin: SupabaseClient,
  companyId: string,
  signals: Signal[],
): Promise<UpsertSignalsResult> {
  if (signals.length === 0) return { written: 0 };

  const personIds = await resolvePeople(admin, signals);

  const rows = signals.map((signal) => ({
    company_id: companyId,
    // Null for every signal today. Resolved anyway so the day a person-level
    // provider lands, `signals.person_id` is already fed and nothing downstream
    // needs to change — see sources/person-engagement.ts.
    person_id: signal.personLinkedinUrl
      ? (personIds.get(signal.personLinkedinUrl) ?? null)
      : null,
    type: signal.type,
    title: signal.title,
    payload: signal.payload ?? null,
    evidence_url: signal.evidenceUrl ?? null,
    strength: signal.strength,
    detected_at: signal.detectedAt.toISOString(),
    dedupe_key: scopedDedupeKey(companyId, signal.dedupeKey),
  }));

  const { error } = await admin
    .from("signals")
    .upsert(rows, { onConflict: "dedupe_key" });

  if (error) return { written: 0, error: `Writing signals failed: ${error.message}` };
  return { written: rows.length };
}

/** LinkedIn URL → person id, for the signals that name a person. */
async function resolvePeople(
  admin: SupabaseClient,
  signals: Signal[],
): Promise<Map<string, string>> {
  const urls = [
    ...new Set(
      signals
        .map((signal) => signal.personLinkedinUrl)
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  const found = new Map<string, string>();
  if (urls.length === 0) return found;

  const { data, error } = await admin
    .from("people")
    .select("id, linkedin_url")
    .in("linkedin_url", urls);

  if (error) {
    console.error("Resolving signal people failed:", error.message);
    return found;
  }
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const url = optionalString(row.linkedin_url);
    const id = optionalString(row.id);
    if (url && id) found.set(url, id);
  }
  return found;
}
