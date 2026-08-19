import { describe, expect, it } from "vitest";
import {
  guardSend,
  nextBusinessDay,
  scheduleSendTimes,
  type SendGuardInput,
} from "./send-guard";

/**
 * The last gate before a message leaves. Everything upstream is advisory;
 * this is where a mistake actually reaches someone's inbox, so it is
 * deliberately paranoid.
 */

function input(overrides: Partial<SendGuardInput> = {}): SendGuardInput {
  return {
    recipientEmail: "ana@firma.ro",
    recipientCountry: "GB",
    isRoleAddress: false,
    suppressed: false,
    autoSend: false,
    complianceAcknowledged: false,
    sentToday: 0,
    dailyLimit: 30,
    alreadySentToLead: false,
    campaignActive: true,
    ...overrides,
  };
}

describe("guardSend — hard blocks", () => {
  it("blocks a suppressed recipient", () => {
    // Re-checked here even though the pipeline checked: an unsubscribe can
    // land between queueing and sending.
    const decision = guardSend(input({ suppressed: true }));
    expect(decision).toMatchObject({
      allowed: false,
      code: "suppressed",
      retryable: false,
    });
  });

  it("blocks a duplicate send to the same lead", () => {
    // Guards against a retry or double-queue mailing someone twice.
    expect(guardSend(input({ alreadySentToLead: true }))).toMatchObject({
      allowed: false,
      code: "duplicate",
      retryable: false,
    });
  });

  it("blocks a malformed address", () => {
    for (const email of ["not-an-email", "a@b", "", "a@@b.ro"]) {
      expect(guardSend(input({ recipientEmail: email }))).toMatchObject({
        allowed: false,
        code: "invalid_recipient",
      });
    }
  });

  it("blocks an address containing a newline", () => {
    // Would let the recipient field inject headers downstream.
    expect(
      guardSend(input({ recipientEmail: "ana@firma.ro\r\nBcc: x@evil.com" })),
    ).toMatchObject({ allowed: false, code: "invalid_recipient" });
  });
});

describe("guardSend — retryable blocks", () => {
  it("blocks at the daily limit, retryably", () => {
    const decision = guardSend(input({ sentToday: 30, dailyLimit: 30 }));
    expect(decision).toMatchObject({
      allowed: false,
      code: "daily_limit",
      retryable: true,
    });
  });

  it("allows the send that reaches the limit", () => {
    // Off-by-one guard: 29 sent against a limit of 30 must still go.
    expect(guardSend(input({ sentToday: 29, dailyLimit: 30 })).allowed).toBe(true);
  });

  it("blocks while the campaign is paused", () => {
    expect(guardSend(input({ campaignActive: false }))).toMatchObject({
      allowed: false,
      code: "campaign_inactive",
      retryable: true,
    });
  });
});

describe("guardSend — compliance", () => {
  it("blocks unattended auto-send into a strict market", () => {
    // The one compliance case that blocks. A human clicking send has made the
    // decision; an unattended queue has not.
    const decision = guardSend(
      input({
        recipientCountry: "RO",
        autoSend: true,
        complianceAcknowledged: false,
      }),
    );

    expect(decision).toMatchObject({
      allowed: false,
      code: "needs_acknowledgement",
      retryable: true,
    });
  });

  it("allows auto-send into a strict market once acknowledged", () => {
    expect(
      guardSend(
        input({
          recipientCountry: "RO",
          autoSend: true,
          complianceAcknowledged: true,
        }),
      ).allowed,
    ).toBe(true);
  });

  it("allows a manually reviewed send to Romania without acknowledgement", () => {
    // The user is looking at the message; that is the acknowledgement.
    const decision = guardSend(input({ recipientCountry: "RO", autoSend: false }));
    expect(decision.allowed).toBe(true);
  });

  it("surfaces compliance warnings alongside an allowed send", () => {
    const decision = guardSend(input({ recipientCountry: "RO", autoSend: false }));
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.warnings.join(" ")).toMatch(/consent/i);
      expect(decision.verdict.jurisdiction.countryName).toBe("Romania");
    }
  });

  it("raises no warnings for a permissive market", () => {
    const decision = guardSend(input({ recipientCountry: "GB", autoSend: true }));
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.warnings).toEqual([]);
  });

  it("puts suppression ahead of every other check", () => {
    // Ordering matters: a suppressed recipient in a paused campaign should
    // report the permanent reason, not the retryable one.
    const decision = guardSend(
      input({ suppressed: true, campaignActive: false, sentToday: 999 }),
    );
    expect(decision).toMatchObject({ code: "suppressed", retryable: false });
  });
});

describe("scheduleSendTimes", () => {
  const day = new Date("2026-06-01T00:00:00");

  it("spreads sends across the working window", () => {
    // Thirty messages in one minute looks like a blast to every spam filter.
    const times = scheduleSendTimes({ count: 10, dayStart: day, random: () => 0.5 });

    expect(times).toHaveLength(10);
    for (const time of times) {
      expect(time.getHours()).toBeGreaterThanOrEqual(9);
      expect(time.getHours()).toBeLessThan(17);
    }
  });

  it("returns times in ascending order", () => {
    const times = scheduleSendTimes({ count: 8, dayStart: day });
    const sorted = [...times].sort((a, b) => a.getTime() - b.getTime());
    expect(times).toEqual(sorted);
  });

  it("jitters within each slot rather than spacing evenly", () => {
    // Perfectly even spacing is as machine-looking as simultaneous sends.
    let seed = 0;
    const times = scheduleSendTimes({
      count: 5,
      dayStart: day,
      random: () => ((seed += 0.37) % 1),
    });

    const gaps = times.slice(1).map((t, i) => t.getTime() - times[i].getTime());
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  it("honours a custom window", () => {
    const times = scheduleSendTimes({
      count: 4,
      dayStart: day,
      startHour: 14,
      endHour: 16,
      random: () => 0.1,
    });
    for (const time of times) {
      expect(time.getHours()).toBeGreaterThanOrEqual(14);
      expect(time.getHours()).toBeLessThan(16);
    }
  });

  it("returns nothing for a zero count or an inverted window", () => {
    expect(scheduleSendTimes({ count: 0, dayStart: day })).toEqual([]);
    expect(
      scheduleSendTimes({ count: 5, dayStart: day, startHour: 17, endHour: 9 }),
    ).toEqual([]);
  });
});

describe("nextBusinessDay", () => {
  it("skips the weekend", () => {
    // B2B mail sent on Saturday is read on Monday, if at all.
    const friday = new Date("2026-06-05T10:00:00");
    expect(nextBusinessDay(friday).getDay()).toBe(1);
  });

  it("advances one day midweek", () => {
    const tuesday = new Date("2026-06-02T10:00:00");
    const next = nextBusinessDay(tuesday);
    expect(next.getDay()).toBe(3);
  });

  it("moves Saturday and Sunday to Monday", () => {
    expect(nextBusinessDay(new Date("2026-06-06T10:00:00")).getDay()).toBe(1);
    expect(nextBusinessDay(new Date("2026-06-07T10:00:00")).getDay()).toBe(1);
  });
});
