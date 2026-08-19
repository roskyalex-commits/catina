/**
 * Plan limits.
 *
 * The free tier has to be genuinely useful, not a demo — the competitor
 * charges $99/mo with a trial, and "a free tier that actually works" is a
 * stated part of the wedge. So the limits are set where our own costs
 * actually bite rather than where they'd best drive an upgrade.
 *
 * Two things cost real money at MVP scale: Claude tokens (a few euro a month)
 * and vendor enrichment credits. Registry lookups, crawling and DNS are free,
 * so the free tier is generous on those and tight on the metered ones.
 */

export type PlanId = "free" | "pro" | "custom";

export type PlanLimits = {
  id: PlanId;
  name: string;
  priceEurMonthly: number | null;
  /** Companies held in the workspace at once. */
  maxCompanies: number;
  /** Leads enriched per month — the metered path. */
  maxEnrichmentsPerMonth: number;
  /** Claude-drafted messages per month. */
  maxDraftsPerMonth: number;
  maxConnectedMailboxes: number;
  maxSendsPerDay: number;
  maxAgents: number;
  maxSeats: number;
  /** Signal scan frequency. Free tier scans daily rather than hourly. */
  scanIntervalHours: number;
  csvExport: boolean;
  autoSend: boolean;
};

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    name: "Free",
    priceEurMonthly: 0,
    // Generous: sourcing from the Romanian registry costs us nothing.
    maxCompanies: 1_000,
    // Tight: this is the path that spends vendor credits.
    maxEnrichmentsPerMonth: 50,
    maxDraftsPerMonth: 50,
    maxConnectedMailboxes: 1,
    maxSendsPerDay: 20,
    maxAgents: 1,
    maxSeats: 1,
    scanIntervalHours: 24,
    csvExport: true,
    // Withheld on free deliberately: an unattended sender on an unverified
    // account is how a shared reputation gets burned.
    autoSend: false,
  },
  pro: {
    id: "pro",
    name: "Pro",
    // Undercuts the competitor's $99 while covering the metered costs.
    priceEurMonthly: 49,
    maxCompanies: 50_000,
    maxEnrichmentsPerMonth: 2_000,
    maxDraftsPerMonth: 2_000,
    maxConnectedMailboxes: 3,
    maxSendsPerDay: 100,
    maxAgents: 5,
    maxSeats: 3,
    scanIntervalHours: 1,
    csvExport: true,
    autoSend: true,
  },
  custom: {
    id: "custom",
    name: "Custom",
    priceEurMonthly: null,
    maxCompanies: Number.MAX_SAFE_INTEGER,
    maxEnrichmentsPerMonth: Number.MAX_SAFE_INTEGER,
    maxDraftsPerMonth: Number.MAX_SAFE_INTEGER,
    maxConnectedMailboxes: 20,
    maxSendsPerDay: 500,
    maxAgents: 50,
    maxSeats: 50,
    scanIntervalHours: 1,
    csvExport: true,
    autoSend: true,
  },
};

export type MeteredResource =
  | "companies"
  | "enrichments"
  | "drafts"
  | "mailboxes"
  | "sendsToday"
  | "agents"
  | "seats";

const LIMIT_KEYS: Record<MeteredResource, keyof PlanLimits> = {
  companies: "maxCompanies",
  enrichments: "maxEnrichmentsPerMonth",
  drafts: "maxDraftsPerMonth",
  mailboxes: "maxConnectedMailboxes",
  sendsToday: "maxSendsPerDay",
  agents: "maxAgents",
  seats: "maxSeats",
};

/** Wording is per resource, because "upgrade" alone tells the user nothing. */
const RESOURCE_LABELS: Record<MeteredResource, string> = {
  companies: "companies in your workspace",
  enrichments: "lead enrichments this month",
  drafts: "drafted messages this month",
  mailboxes: "connected mailboxes",
  sendsToday: "messages sent today",
  agents: "agents",
  seats: "team members",
};

export type QuotaCheck = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  /** 0-1, for a progress bar. */
  fraction: number;
  /** True past 80% — the point worth warning at, before work is refused. */
  nearLimit: boolean;
  message?: string;
};

export function checkQuota(
  plan: PlanId,
  resource: MeteredResource,
  used: number,
  /** How many more are about to be consumed. */
  requesting = 1,
): QuotaCheck {
  const limits = PLANS[plan] ?? PLANS.free;
  const limit = limits[LIMIT_KEYS[resource]] as number;
  const remaining = Math.max(0, limit - used);
  const allowed = used + requesting <= limit;
  const fraction = limit > 0 ? Math.min(1, used / limit) : 1;

  return {
    allowed,
    used,
    limit,
    remaining,
    fraction,
    nearLimit: fraction >= 0.8,
    message: allowed
      ? fraction >= 0.8
        ? `${remaining} of ${limit} ${RESOURCE_LABELS[resource]} left on ${limits.name}.`
        : undefined
      : `You've used all ${limit} ${RESOURCE_LABELS[resource]} on ${limits.name}.` +
        (plan === "free" ? " Pro raises this to " + proLimitFor(resource) + "." : ""),
  };
}

function proLimitFor(resource: MeteredResource): string {
  const value = PLANS.pro[LIMIT_KEYS[resource]] as number;
  return value >= Number.MAX_SAFE_INTEGER ? "unlimited" : value.toLocaleString("en");
}

export function canUseFeature(
  plan: PlanId,
  feature: "csvExport" | "autoSend",
): boolean {
  return Boolean((PLANS[plan] ?? PLANS.free)[feature]);
}

/**
 * Whether a scan is due.
 *
 * Free scans daily, Pro hourly. The interval is a real cost lever: each scan
 * hits ANAF, a careers page and a news feed per company, and on the free tier
 * that adds up faster than anything else.
 */
export function isScanDue(
  plan: PlanId,
  lastScanAt: Date | null | undefined,
  now = new Date(),
): boolean {
  if (!lastScanAt) return true;
  const intervalMs = (PLANS[plan] ?? PLANS.free).scanIntervalHours * 3600_000;
  return now.getTime() - lastScanAt.getTime() >= intervalMs;
}
