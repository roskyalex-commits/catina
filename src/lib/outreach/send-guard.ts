import { evaluateCompliance, type ComplianceVerdict } from "./compliance";

/**
 * The last check before a message leaves.
 *
 * Everything upstream — scoring, drafting, compliance warnings — is advisory.
 * This is the gate, and it is deliberately paranoid: it re-checks suppression
 * even though the pipeline already did, because the pipeline runs minutes or
 * hours before the send and an unsubscribe can arrive in between.
 */

export type SendGuardInput = {
  recipientEmail: string;
  recipientCountry?: string | null;
  isRoleAddress: boolean;
  hasConsent?: boolean;
  /** Checked fresh at send time, not inherited from the queue message. */
  suppressed: boolean;
  autoSend: boolean;
  complianceAcknowledged: boolean;
  /** Sends already made from this mailbox today. */
  sentToday: number;
  dailyLimit: number;
  /** Prevents the same lead being mailed twice by a retry or a double-queue. */
  alreadySentToLead: boolean;
  /** Set when the campaign is paused mid-flight. */
  campaignActive: boolean;
};

export type SendDecision =
  | { allowed: true; verdict: ComplianceVerdict; warnings: string[] }
  | { allowed: false; reason: string; code: SendBlockCode; retryable: boolean };

export type SendBlockCode =
  | "suppressed"
  | "duplicate"
  | "daily_limit"
  | "campaign_inactive"
  | "needs_acknowledgement"
  | "invalid_recipient";

export function guardSend(input: SendGuardInput): SendDecision {
  if (!isSendableAddress(input.recipientEmail)) {
    return {
      allowed: false,
      code: "invalid_recipient",
      reason: "Recipient address is not a valid email",
      retryable: false,
    };
  }

  // Re-checked here on purpose: the pipeline's check happened earlier, and an
  // unsubscribe that lands in between must still be honoured.
  if (input.suppressed) {
    return {
      allowed: false,
      code: "suppressed",
      reason: "Recipient is on the do-not-contact list",
      retryable: false,
    };
  }

  if (input.alreadySentToLead) {
    return {
      allowed: false,
      code: "duplicate",
      reason: "This lead has already been contacted in this campaign",
      retryable: false,
    };
  }

  if (!input.campaignActive) {
    return {
      allowed: false,
      code: "campaign_inactive",
      reason: "Campaign is paused",
      // Resuming the campaign makes this send valid again.
      retryable: true,
    };
  }

  if (input.sentToday >= input.dailyLimit) {
    return {
      allowed: false,
      code: "daily_limit",
      reason: `Daily send limit of ${input.dailyLimit} reached for this mailbox`,
      retryable: true,
    };
  }

  const verdict = evaluateCompliance({
    recipientCountry: input.recipientCountry,
    recipientEmail: input.recipientEmail,
    isRoleAddress: input.isRoleAddress,
    hasConsent: input.hasConsent,
    suppressed: input.suppressed,
    autoSend: input.autoSend,
    complianceAcknowledged: input.complianceAcknowledged,
  });

  // Auto-send into a strict market without an explicit acknowledgement is the
  // one compliance case that blocks. A human clicking send has made the
  // decision themselves; an unattended queue has not.
  if (input.autoSend && verdict.requiresAcknowledgement) {
    return {
      allowed: false,
      code: "needs_acknowledgement",
      reason:
        `Auto-send into ${verdict.jurisdiction.countryName} needs your explicit ` +
        "acknowledgement first — it requires prior consent",
      retryable: true,
    };
  }

  return {
    allowed: true,
    verdict,
    warnings: verdict.issues
      .filter((issue) => issue.severity !== "info")
      .map((issue) => issue.message),
  };
}

function isSendableAddress(email: string): boolean {
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed)) return false;
  // A newline would let the address inject headers downstream.
  return !/[\r\n]/.test(trimmed);
}

/**
 * Spreads a day's sends across working hours.
 *
 * Thirty messages leaving in the same minute looks like a blast to every spam
 * filter, and lands at a time nobody reads. Jitter keeps the pattern human.
 */
export function scheduleSendTimes(options: {
  count: number;
  dayStart: Date;
  /** Local working window, 24h. */
  startHour?: number;
  endHour?: number;
  random?: () => number;
}): Date[] {
  const startHour = options.startHour ?? 9;
  const endHour = options.endHour ?? 17;
  const random = options.random ?? Math.random;

  if (options.count <= 0) return [];
  if (endHour <= startHour) return [];

  const windowMs = (endHour - startHour) * 3600_000;
  const slot = windowMs / options.count;
  const base = new Date(options.dayStart);
  base.setHours(startHour, 0, 0, 0);

  return Array.from({ length: options.count }, (_, i) => {
    // One send per slot, jittered within it — evenly spaced sends are as
    // machine-looking as simultaneous ones.
    const offset = slot * i + random() * slot;
    return new Date(base.getTime() + offset);
  }).sort((a, b) => a.getTime() - b.getTime());
}

/** Weekends are skipped: B2B mail sent on Saturday is read on Monday, if at all. */
export function nextBusinessDay(from: Date): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}
