import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageRecord, UsageStore } from "./ledger";

/**
 * Credit ledger backed by `provider_usage`.
 *
 * Must be constructed with the service-role client: RLS denies all user access
 * to `provider_usage` by design, so a request-scoped client reads nothing here
 * and every provider would look unmetered.
 *
 * Free-tier sizes are configuration, not data — they change when a vendor
 * changes its plans, and they are the same for every org. Passing them in
 * keeps the numbers in one place (`FREE_TIER_LIMITS`) rather than scattered
 * across rows nobody remembers to update.
 */
export class SupabaseUsageStore implements UsageStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly limits: Record<string, number> = {},
  ) {}

  async get(
    orgId: string,
    provider: string,
    periodMonth: string,
  ): Promise<UsageRecord | null> {
    const { data, error } = await this.db
      .from("provider_usage")
      .select("provider, period_month, credits_used, credits_limit")
      .eq("org_id", orgId)
      .eq("provider", provider)
      .eq("period_month", periodMonth)
      .maybeSingle();

    if (error) {
      throw new Error(`Reading provider_usage failed: ${error.message}`);
    }

    if (!data) {
      // No row yet this month — that is zero spend, not "unknown". Returning
      // null here would make the ledger treat a metered provider as unmetered.
      return {
        provider,
        periodMonth,
        creditsUsed: 0,
        creditsLimit: this.limits[provider],
      };
    }

    return {
      provider,
      periodMonth,
      creditsUsed: Number(data.credits_used ?? 0),
      creditsLimit:
        data.credits_limit === null || data.credits_limit === undefined
          ? this.limits[provider]
          : Number(data.credits_limit),
    };
  }

  /**
   * Atomic increment via the `increment_provider_usage` function.
   *
   * A read-modify-write from the application would lose counts under the
   * concurrent enrichment the queue runs by design, and an undercounted
   * ledger is exactly the failure it exists to prevent.
   */
  async increment(
    orgId: string,
    provider: string,
    periodMonth: string,
    by: number,
  ): Promise<void> {
    const { error } = await this.db.rpc("increment_provider_usage", {
      p_org_id: orgId,
      p_provider: provider,
      p_period_month: periodMonth,
      p_amount: by,
      p_limit: this.limits[provider] ?? null,
    });

    if (error) {
      throw new Error(`Recording provider usage failed: ${error.message}`);
    }
  }
}

/**
 * Documented free-tier allowances, deliberately conservative.
 *
 * These are starting values, not verified ones — vendor pricing pages move and
 * the numbers in blog comparisons are frequently stale. `npm run spike:people`
 * reads the live figure from each provider's account endpoint; correct these
 * from its output. Under-stating a limit costs a few unused lookups, while
 * over-stating it means hitting 429s mid-run, so the defaults lean low.
 */
export const FREE_TIER_LIMITS: Record<string, number> = {
  hunter: 25,
  prospeo: 75,
  pdl: 100,
  apify: 100,
};
