import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GmailError } from "./gmail";
import {
  dueMessageFrom,
  sendOne,
  unsubscribeUrlFor,
  type DueMessage,
  type SendContext,
} from "./send";

/**
 * The last gate before a stranger's inbox.
 *
 * Everything here is about the difference between "do not send this, ever" and
 * "do not send this yet" — because collapsing the two is how a campaign either
 * mails an opt-out or quietly abandons half its queue the first time it hits a
 * daily cap. Both failures are invisible in a summary line that says "20 sent".
 */

type Row = Record<string, unknown>;

/**
 * A Supabase stand-in that answers the two shapes this file uses: the
 * suppression lookup (`select … eq … in`) and the state writes (`update … eq`).
 */
function fakeDb(options: { suppressed?: string[]; updateError?: string } = {}) {
  const updates: { table: string; values: Row }[] = [];

  const client = {
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          in: () =>
            Promise.resolve({
              data: (options.suppressed ?? []).map((value) => ({ value, kind: "address" })),
              error: null,
            }),
        }),
      }),
      update: (values: Row) => ({
        eq: () => {
          updates.push({ table, values });
          return Promise.resolve({
            error: options.updateError ? { message: options.updateError } : null,
          });
        },
      }),
    })),
  } as unknown as SupabaseClient;

  return { client, updates };
}

function message(overrides: Partial<DueMessage> = {}): DueMessage {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    leadId: "lead-1",
    subject: "WooCommerce și facturarea",
    body: "Am văzut că folosiți WooCommerce.",
    recipientName: "Marușca Vlad",
    recipientEmail: "vlad.marusca@redbeesoftware.com",
    recipientCountry: "RO",
    isRoleAddress: false,
    ...overrides,
  };
}

function context(overrides: Partial<SendContext> = {}): SendContext {
  const { client } = fakeDb();
  return {
    admin: client,
    orgId: "org-1",
    gmail: null,
    sender: { email: "eu@firma.ro", senderName: "Alex", senderCompany: "Cătină" },
    campaign: {
      id: "campaign-1",
      autoSend: false,
      active: true,
      dailyLimit: 30,
      complianceAcknowledged: true,
    },
    sentToday: 0,
    appUrl: "https://catina.ro",
    dryRun: true,
    ...overrides,
  };
}

/** A GmailClient stand-in. Records what it was asked to do. */
function fakeGmail(behaviour?: { throws?: unknown }) {
  const calls: { method: string; to: string; body: string }[] = [];
  const handler = (method: string) => async (payload: { to: { email: string }; body: string }) => {
    if (behaviour?.throws) throw behaviour.throws;
    calls.push({ method, to: payload.to.email, body: payload.body });
    return { messageId: `${method}-id`, threadId: "thread-1" };
  };
  return {
    calls,
    client: {
      send: handler("send"),
      createDraft: handler("draft"),
    } as unknown as NonNullable<SendContext["gmail"]>,
  };
}

describe("a dry run touches nothing", () => {
  it("reports what would happen without calling Gmail", async () => {
    const gmail = fakeGmail();
    const outcome = await sendOne(
      context({ dryRun: true, gmail: gmail.client }),
      message(),
    );

    expect(outcome.state).toBe("would_send");
    expect(gmail.calls).toHaveLength(0);
  });
});

describe("draft mode is the default, and it is a real mode", () => {
  it("creates a Gmail draft rather than sending", async () => {
    const gmail = fakeGmail();
    const db = fakeDb();
    const outcome = await sendOne(
      context({ dryRun: false, gmail: gmail.client, admin: db.client }),
      message(),
    );

    expect(outcome.state).toBe("in_gmail_drafts");
    expect(gmail.calls[0]?.method).toBe("draft");
    // No `sent_at`: nothing has been sent, and a timestamp here would make the
    // daily cap count drafts against a send limit.
    const messageUpdate = db.updates.find((update) => update.table === "messages");
    expect(messageUpdate?.values.sent_at).toBeUndefined();
    expect(messageUpdate?.values.gmail_draft_id).toBe("draft-id");
  });

  it("sends outright only when the campaign says to", async () => {
    const gmail = fakeGmail();
    const db = fakeDb();
    const outcome = await sendOne(
      context({
        dryRun: false,
        gmail: gmail.client,
        admin: db.client,
        campaign: { ...context().campaign, autoSend: true },
      }),
      message(),
    );

    expect(outcome.state).toBe("sent");
    expect(gmail.calls[0]?.method).toBe("send");
    expect(db.updates.find((u) => u.table === "messages")?.values.sent_at).toBeTruthy();
    expect(db.updates.find((u) => u.table === "leads")?.values.status).toBe("sent");
  });
});

describe("skipped and deferred are different answers", () => {
  it("closes out a suppressed recipient permanently", async () => {
    /*
     * Re-read here rather than inherited from the queue: the drafting run
     * happened hours ago and an unsubscribe can land in between. That gap is
     * the entire reason `guardSend` takes `suppressed` as an argument.
     */
    const db = fakeDb({ suppressed: ["vlad.marusca@redbeesoftware.com"] });
    const gmail = fakeGmail();
    const outcome = await sendOne(
      context({ dryRun: false, gmail: gmail.client, admin: db.client }),
      message(),
    );

    expect(outcome.state).toBe("skipped");
    expect(gmail.calls).toHaveLength(0);
    expect(db.updates.find((u) => u.table === "messages")?.values.state).toBe("skipped");
  });

  it("leaves a message alone when the daily cap is reached", async () => {
    // Deferred, not skipped. Marking it skipped would abandon the rest of a
    // campaign the first day it hit its own limit.
    const db = fakeDb();
    const outcome = await sendOne(
      context({
        dryRun: false,
        gmail: fakeGmail().client,
        admin: db.client,
        sentToday: 30,
        campaign: { ...context().campaign, autoSend: true, dailyLimit: 30 },
      }),
      message(),
    );

    expect(outcome.state).toBe("deferred");
    expect(db.updates).toHaveLength(0);
  });

  it("leaves a message alone when the campaign is paused", async () => {
    const db = fakeDb();
    const outcome = await sendOne(
      context({
        dryRun: false,
        gmail: fakeGmail().client,
        admin: db.client,
        campaign: { ...context().campaign, autoSend: true, active: false },
      }),
      message(),
    );

    expect(outcome.state).toBe("deferred");
    expect(db.updates).toHaveLength(0);
  });

  it("closes out an unsendable address", async () => {
    const db = fakeDb();
    const outcome = await sendOne(
      context({ dryRun: false, gmail: fakeGmail().client, admin: db.client }),
      message({ recipientEmail: "not-an-address" }),
    );

    expect(outcome.state).toBe("skipped");
    if (outcome.state === "skipped") expect(outcome.code).toBe("invalid_recipient");
  });
});

describe("when Gmail refuses", () => {
  it("defers a rate limit rather than retiring the message", async () => {
    const db = fakeDb();
    const gmail = fakeGmail({ throws: new GmailError("rate limited", 429) });
    const outcome = await sendOne(
      context({ dryRun: false, gmail: gmail.client, admin: db.client }),
      message(),
    );

    expect(outcome.state).toBe("deferred");
    // Nothing written: the row must stay eligible for the next run.
    expect(db.updates).toHaveLength(0);
  });

  it("records a real failure with its reason", async () => {
    const db = fakeDb();
    const gmail = fakeGmail({ throws: new GmailError("Gmail API error 400: bad", 400) });
    const outcome = await sendOne(
      context({ dryRun: false, gmail: gmail.client, admin: db.client }),
      message(),
    );

    expect(outcome.state).toBe("failed");
    const update = db.updates.find((u) => u.table === "messages");
    expect(update?.values.state).toBe("failed");
    expect(String(update?.values.failure_reason)).toContain("400");
  });

  it("stops the run if a send cannot be recorded", async () => {
    /*
     * The one place this throws instead of returning. Gmail has accepted the
     * message; if we cannot write that down, the next run sends it again — and
     * a duplicate cold email is the one mistake a recipient always notices.
     */
    const db = fakeDb({ updateError: "connection reset" });
    await expect(
      sendOne(
        context({
          dryRun: false,
          gmail: fakeGmail().client,
          admin: db.client,
          campaign: { ...context().campaign, autoSend: true },
        }),
        message(),
      ),
    ).rejects.toThrow(/second time/);
  });
});

describe("the unsubscribe link", () => {
  it("carries the message id and not the address", () => {
    // A URL ends up in proxy logs, browser history and referrer headers. The
    // message id identifies the recipient without publishing their email.
    const url = unsubscribeUrlFor("https://catina.ro/", "abc-123");
    expect(url).toBe("https://catina.ro/api/v1/unsubscribe?m=abc-123");
    expect(url).not.toContain("@");
  });
});

describe("reading a due message row", () => {
  it("maps the joined shape", () => {
    const mapped = dueMessageFrom({
      id: "message-1",
      lead_id: "lead-1",
      subject: "s",
      body: "b",
      leads: {
        people: { full_name: "Banu Cristian" },
        companies: { name: "Certplus", country: "RO" },
        emails: { address: "cristian.banu@certplus.ro", is_role_address: false },
      },
    });

    expect(mapped?.recipientEmail).toBe("cristian.banu@certplus.ro");
    expect(mapped?.recipientCountry).toBe("RO");
  });

  it("drops a message whose lead lost its address", () => {
    // Enrichment can disprove an address between drafting and sending. Keeping
    // the row out of the loop entirely beats failing an address check inside it.
    const mapped = dueMessageFrom({
      id: "message-1",
      lead_id: "lead-1",
      subject: "s",
      body: "b",
      leads: { people: { full_name: "X" }, companies: { name: "Y" }, emails: null },
    });
    expect(mapped).toBeNull();
  });
});
