/**
 * Free-tier credit ledger.
 *
 * The waterfall reads this before calling a provider, so an exhausted free
 * tier is skipped rather than hammered into a 429. Without it, one busy day
 * burns a month's allowance on the first provider in the chain and every
 * subsequent lookup silently degrades.
 *
 * Budgets are per org, per provider, per calendar month, matching how free
 * tiers actually reset.
 */

export type UsageRecord = {
  provider: string;
  periodMonth: string;
  creditsUsed: number;
  creditsLimit?: number;
};

export interface UsageStore {
  get(orgId: string, provider: string, periodMonth: string): Promise<UsageRecord | null>;
  increment(
    orgId: string,
    provider: string,
    periodMonth: string,
    by: number,
  ): Promise<void>;
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * In-memory store. Real deployments use the `provider_usage` table via
 * `SupabaseUsageStore`; this exists so the waterfall is testable and so a
 * single-process job can run without a database.
 */
export class MemoryUsageStore implements UsageStore {
  private readonly records = new Map<string, UsageRecord>();

  constructor(private readonly limits: Record<string, number> = {}) {}

  private key(orgId: string, provider: string, period: string) {
    return `${orgId}:${provider}:${period}`;
  }

  async get(orgId: string, provider: string, periodMonth: string) {
    return (
      this.records.get(this.key(orgId, provider, periodMonth)) ?? {
        provider,
        periodMonth,
        creditsUsed: 0,
        creditsLimit: this.limits[provider],
      }
    );
  }

  async increment(orgId: string, provider: string, periodMonth: string, by: number) {
    const key = this.key(orgId, provider, periodMonth);
    const existing = await this.get(orgId, provider, periodMonth);
    this.records.set(key, {
      ...existing,
      creditsUsed: existing.creditsUsed + by,
    });
  }
}

export class CreditLedger {
  constructor(
    private readonly store: UsageStore,
    private readonly orgId: string,
  ) {}

  /** False when the provider's monthly allowance is spent. */
  async hasBudget(provider: string, cost = 1): Promise<boolean> {
    const record = await this.store.get(this.orgId, provider, currentPeriod());
    // No record yet, or no configured limit, means unmetered — our own
    // crawler, DNS and the registries have no allowance to exhaust.
    if (!record || record.creditsLimit === undefined) return true;
    return record.creditsUsed + cost <= record.creditsLimit;
  }

  async remaining(provider: string): Promise<number | undefined> {
    const record = await this.store.get(this.orgId, provider, currentPeriod());
    if (!record || record.creditsLimit === undefined) return undefined;
    return Math.max(0, record.creditsLimit - record.creditsUsed);
  }

  async spend(provider: string, cost = 1): Promise<void> {
    await this.store.increment(this.orgId, provider, currentPeriod(), cost);
  }
}
