import { describe, expect, it } from "vitest";
import type { Signal } from "@/lib/signals/types";
import {
  SENDABLE_STATUSES,
  UNVERIFIED_STATUSES,
  eligibleForOutreach,
  outreachLeadFrom,
  strongestSignal,
  type OutreachLead,
} from "./pipeline";

/**
 * These are the rules that decide whether a stranger receives an email, so they
 * are tested from the refusals inwards. A false negative here costs one lead. A
 * false positive costs a bounce, a complaint, or a message to someone who asked
 * not to be written to — and only the first of those is recoverable.
 */

const DAY = 86_400_000;

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "keyword_on_site",
    title: "Runs WooCommerce today",
    strength: 0.5,
    detectedAt: new Date(Date.now() - 2 * DAY),
    dedupeKey: "company-1:woo",
    evidenceUrl: "https://exemplu.ro",
    ...overrides,
  };
}

function lead(overrides: Partial<OutreachLead> = {}): OutreachLead {
  return {
    leadId: "lead-1",
    orgId: "org-1",
    agentId: "agent-1",
    companyId: "company-1",
    personId: "person-1",
    status: "new",
    score: 76,
    fullName: "Marușca Vlad",
    firstName: "Vlad",
    title: "administrator",
    companyName: "Red Bee Software SRL",
    country: "RO",
    email: {
      address: "vlad.marusca@redbeesoftware.com",
      status: "verified",
      confidence: 0.9,
      isRoleAddress: false,
    },
    ...overrides,
  };
}

const clean = { signals: [signal()], suppressed: false, alreadyMessaged: false };

describe("who gets written to", () => {
  it("passes a lead with a verified address and a signal", () => {
    const verdict = eligibleForOutreach(lead(), clean);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.signal.title).toBe("Runs WooCommerce today");
  });

  it("passes an address read off the company's own website", () => {
    // `found` means the crawler saw it published. That is weaker evidence than
    // a mailbox probe but it is evidence, unlike a guess.
    const verdict = eligibleForOutreach(
      lead({ email: { address: "office@exemplu.ro", status: "found", confidence: 0.6, isRoleAddress: true } }),
      clean,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("what it refuses, which is the part that matters", () => {
  it("refuses an address nothing ever confirmed", () => {
    /*
     * The expensive mistake. A `pattern` address is `first.last@domain` with
     * nobody having checked whether that mailbox exists. Sending a batch of
     * them is the fastest available way to make every subsequent message land
     * in a spam folder.
     */
    const verdict = eligibleForOutreach(
      lead({ email: { address: "guess@exemplu.ro", status: "pattern", confidence: 0.35, isRoleAddress: false } }),
      clean,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("unverified_email");
  });

  it("allows the guess only when asked explicitly", () => {
    const verdict = eligibleForOutreach(
      lead({ email: { address: "guess@exemplu.ro", status: "pattern", confidence: 0.35, isRoleAddress: false } }),
      { ...clean, allowedStatuses: UNVERIFIED_STATUSES },
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses a known-bad address even with the override on", () => {
    for (const status of ["invalid", "bounced", "risky"] as const) {
      const verdict = eligibleForOutreach(
        lead({ email: { address: "x@exemplu.ro", status, confidence: 0.1, isRoleAddress: false } }),
        { ...clean, allowedStatuses: UNVERIFIED_STATUSES },
      );
      expect(verdict.ok, status).toBe(false);
    }
  });

  it("refuses a company in distress rather than opening with it", () => {
    /*
     * The signal is real, recent and strong, which is exactly why this has to
     * be a disqualification and not a ranking. "I saw you've entered insolvency
     * proceedings" is the worst opening line this system could produce.
     */
    const verdict = eligibleForOutreach(lead(), {
      ...clean,
      signals: [
        signal({ type: "insolvency_risk", title: "Insolvency proceedings on record", strength: 1 }),
        signal(),
      ],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("distress");
  });

  it("refuses a lead with nothing specific to say", () => {
    const verdict = eligibleForOutreach(lead(), { ...clean, signals: [] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("no_signal");
  });

  it("refuses a suppressed recipient", () => {
    const verdict = eligibleForOutreach(lead(), { ...clean, suppressed: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("suppressed");
  });

  it("refuses a lead that has already been written to", () => {
    // A re-run, a retry, or two people pressing the button. A duplicate cold
    // email is the one mistake a recipient unambiguously notices.
    const verdict = eligibleForOutreach(lead(), { ...clean, alreadyMessaged: true });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("already_messaged");
  });

  it("refuses a lead with no address at all", () => {
    const verdict = eligibleForOutreach(lead({ email: null }), clean);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("no_email");
  });

  it("refuses a rejected lead", () => {
    const verdict = eligibleForOutreach(lead({ status: "rejected" }), clean);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("rejected");
  });

  it("refuses a lead we cannot address by name", () => {
    const verdict = eligibleForOutreach(lead({ fullName: "  " }), clean);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("no_name");
  });

  it("checks suppression before duplication", () => {
    // Both true. Suppression is the answer worth reporting, because it is the
    // one with a legal weight behind it.
    const verdict = eligibleForOutreach(lead(), {
      ...clean,
      suppressed: true,
      alreadyMessaged: true,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("suppressed");
  });
});

describe("which signal the message opens with", () => {
  it("prefers a fresh weak signal over a stale strong one", () => {
    // The same decay curve the score uses, so the opening line and the number
    // can never disagree about which fact mattered most.
    const chosen = strongestSignal([
      signal({ title: "old", strength: 0.9, detectedAt: new Date(Date.now() - 400 * DAY) }),
      signal({ title: "new", strength: 0.5, detectedAt: new Date(Date.now() - 1 * DAY) }),
    ]);
    expect(chosen?.title).toBe("new");
  });

  it("never returns a distress signal", () => {
    const chosen = strongestSignal([
      signal({ type: "insolvency_risk", title: "insolvency", strength: 1, detectedAt: new Date() }),
    ]);
    expect(chosen).toBeUndefined();
  });
});

describe("reading a joined lead row", () => {
  it("maps the shape PostgREST returns", () => {
    const mapped = outreachLeadFrom({
      id: "lead-9",
      org_id: "org-1",
      agent_id: "agent-1",
      company_id: "company-9",
      person_id: "person-9",
      status: "new",
      score: 82,
      people: { full_name: "Banu Cristian", first_name: "Cristian", title: "administrator" },
      companies: { name: "Certplus SRL", country: "RO" },
      emails: { address: "cristian.banu@certplus.ro", status: "verified", confidence: 0.9 },
    });

    expect(mapped.fullName).toBe("Banu Cristian");
    expect(mapped.email?.address).toBe("cristian.banu@certplus.ro");
    expect(mapped.email?.status).toBe("verified");
    expect(mapped.email?.isRoleAddress).toBe(false);
  });

  it("tolerates an embedded relation arriving as an array", () => {
    // supabase-js types a to-one relation as an object in some versions and an
    // array in others. Crashing on the wrong one would be a version bump away.
    const mapped = outreachLeadFrom({
      id: "lead-9",
      org_id: "org-1",
      agent_id: "agent-1",
      company_id: "company-9",
      people: [{ full_name: "Banu Cristian" }],
      companies: [{ name: "Certplus SRL" }],
      emails: [{ address: "a@b.ro", status: "found" }],
    });
    expect(mapped.companyName).toBe("Certplus SRL");
    expect(mapped.email?.status).toBe("found");
  });

  it("reports no email rather than an empty address", () => {
    const mapped = outreachLeadFrom({
      id: "lead-9",
      org_id: "org-1",
      agent_id: "agent-1",
      company_id: "company-9",
      people: { full_name: "X" },
      companies: { name: "Y" },
      emails: null,
    });
    expect(mapped.email).toBeNull();
  });
});

describe("the default allow-list", () => {
  it("does not include guesses", () => {
    // Pinned, because widening this constant is a one-word change with a
    // reputation-shaped consequence.
    expect(SENDABLE_STATUSES).toEqual(["verified", "found"]);
    expect(SENDABLE_STATUSES).not.toContain("pattern");
  });
});
