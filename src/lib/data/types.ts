import type { ScoreBreakdown } from "@/lib/signals/scoring";

/**
 * View models.
 *
 * Every page reads one of these and nothing else — no Supabase client, no
 * Drizzle row, no scoring call. That is the whole point: today the accessors
 * return fixtures, next pass they run queries, and not a single page component
 * changes. A type here is the contract between the two.
 */

export type RangeKey = "7d" | "30d" | "3m" | "month";

export const RANGE_LABELS: Record<RangeKey, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "3m": "3 months",
  month: "This month",
};

export const RANGE_DAYS: Record<RangeKey, number> = {
  "7d": 7,
  "30d": 30,
  "3m": 90,
  month: new Date().getDate(),
};

/** 1-3, shown as flames. See `flamesFor` in `./score.ts`. */
export type FlameCount = 1 | 2 | 3;

export type EmailStatus =
  | "pattern"
  | "found"
  | "verified"
  | "risky"
  | "invalid"
  | "bounced";

export type FitFeedback = "good" | "unsure" | "bad";

/** How a lead came to be sourced. Groups the Insights grid. */
export type SourceLabel = "keyword" | "lookalike" | "autopilot" | "signal";

export type ContactSignal = {
  title: string;
  /** The public page backing the claim. Absent only for lookalike matches. */
  evidenceUrl?: string;
  /** The keyword or CAEN code the launch ran on, shown beneath the title. */
  query?: string;
  kind: SourceLabel;
};

export type ContactRow = {
  id: string;
  fullName: string;
  title: string | null;
  companyName: string;
  companyDomain: string | null;
  country: string | null;
  county: string | null;
  caen: string | null;
  signal: ContactSignal | null;
  score: number;
  flames: FlameCount;
  breakdown: ScoreBreakdown;
  /**
   * `isRoleAddress` is carried rather than re-derived from the local part: the
   * waterfall already decided, and a second opinion in the UI could disagree
   * with the one the score was computed from.
   */
  email: {
    address: string;
    status: EmailStatus;
    confidence: number;
    isRoleAddress: boolean;
  } | null;
  phone: string | null;
  importedAt: Date;
  list: { id: string; name: string } | null;
  fitFeedback: FitFeedback | null;
  agentId: string;
};

export type AgentStatus = "draft" | "active" | "paused";

export type AgentSummary = {
  id: string;
  name: string;
  status: AgentStatus;
  createdAt: Date;
  nextLaunchAt: Date | null;
  /** Null until a Gmail account is connected. */
  mailbox: { address: string; warmingUp: boolean } | null;
  leadsFound: number;
  contacted: number;
  countries: string[];
};

export type ActivityEvent = {
  id: string;
  /** Headline, e.g. "21 new leads found". */
  title: string;
  /** Second line: the person, keyword or agent. */
  subtitle: string | null;
  kind: "leads_found" | "no_leads" | "email_sent" | "signal" | "launch" | "error";
  at: Date;
  /** Initials for the avatar chip, when the event concerns a person. */
  initials?: string;
};

export type QueuedMessage = {
  id: string;
  contactName: string;
  companyName: string;
  subject: string;
  preview: string;
  /** The signal the copy was built around. */
  reason: string;
  scheduledFor: Date;
  /** Set when the recipient's market needs an acknowledgement before sending. */
  complianceWarning: string | null;
};

export type AgentDetail = AgentSummary & {
  stats: { found: number; contacted: number; replied: number; interested: number };
  /**
   * "Open rate" in the reference product comes from a tracking pixel. We report
   * deliverability instead — the share of leads with a verified or MX-valid
   * address — because it is computed by the enrichment waterfall we already run
   * and does not require embedding a beacon in the recipient's mail.
   */
  sendStats: {
    emailsSent: number;
    bounces: number | null;
    unsubscribes: number;
    deliverablePct: number | null;
  };
  chart: ChartData;
  activity: ActivityEvent[];
  queue: QueuedMessage[];
  leads: ContactRow[];
  sources: {
    keywords: string[];
    industries: string[];
    /** Keys from `industry-definitions.ts`; `caenCodes` is derived from these. */
    industryKeys: string[];
    caenCodes: string[];
    countries: string[];
    targetTitles: string[];
    /** Competitors we can fingerprint, and the ones we can only read as text. */
    competitorTech: string[];
    competitorNames: string[];
    enabledSignals: string[];
  };
  campaign: {
    autoSend: boolean;
    dailySendLimit: number;
    senderEmail: string | null;
    complianceAcknowledged: boolean;
    steps: { stepIndex: number; delayDays: number; instruction: string }[];
  };
  /** Non-null when leads are waiting on the user before anything sends. */
  pendingReview: { count: number } | null;
};

export type ChartSeries = {
  key: string;
  label: string;
  /** CSS custom property name, so legend and line cannot disagree. */
  color: string;
  points: number[];
};

export type ChartData = {
  /** One label per point, already formatted for the axis. */
  labels: string[];
  series: ChartSeries[];
};

export type ReplyRow = {
  id: string;
  contactName: string;
  companyName: string;
  preview: string;
  at: Date;
};

export type DashboardData = {
  greetingName: string;
  activeSignals: number;
  mailboxConnected: boolean;
  nextActions: {
    pendingTasks: number;
    nextLaunchAt: Date | null;
    companiesSourced: number;
    messagesDrafted: number;
  };
  hotOpportunities: number;
  leadsEngaged: number;
  conversations: number;
  pipeline: { valueEur: number | null; dealSizeSet: boolean };
  chart: ChartData;
  hotLeads: ContactRow[];
  replies: ReplyRow[];
};

export type LaunchChip = {
  /** The keyword, CAEN code or agent name the launch ran on. */
  query: string;
  /** What the launch was doing, e.g. "Engagement & Intent". */
  label: string;
  count: number;
};

export type InsightsData = {
  totalLeads: number;
  avgPerDay: number;
  activeSignals: number;
  days: { iso: string; day: string; weekday: string }[];
  rows: {
    agentId: string;
    agentName: string;
    status: AgentStatus;
    /** Keyed by the `iso` values in `days`. */
    cells: Record<string, LaunchChip[]>;
  }[];
};

export type ShellContext = {
  user: { name: string; email: string };
  counts: { newLeads?: number; pendingDrafts?: number; unreadReplies?: number };
  credits: number;
  /** True while the app renders fixtures because no database is configured. */
  demo: boolean;
};
