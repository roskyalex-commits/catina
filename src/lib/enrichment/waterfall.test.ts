import { describe, expect, it, vi } from "vitest";
import { CreditLedger, MemoryUsageStore } from "./ledger";
import type { MailboxVerifier, MxChecker } from "./mx";
import { EmailWaterfall } from "./waterfall";
import type { FoundPerson, PeopleProvider } from "@/lib/sources/people/types";

/**
 * The waterfall's value is entirely in its ordering and its restraint: free
 * steps before paid ones, no credit spent on a domain that takes no mail, and
 * never labelling a guess as verified. Those are what these tests pin.
 */

function fakeMx(result: Partial<{ acceptsMail: boolean; error: string }>) {
  return {
    check: vi.fn(async (domain: string) => ({
      domain,
      acceptsMail: result.acceptsMail ?? true,
      hosts: result.acceptsMail === false ? [] : ["aspmx.l.google.com"],
      isFreeProvider: false,
      provider: "google" as const,
      error: result.error,
    })),
  } as unknown as MxChecker;
}

function fakeProvider(
  key: string,
  people: FoundPerson[],
  options: { configured?: boolean; throws?: string } = {},
): PeopleProvider {
  return {
    key,
    label: key,
    freeTierNote: "",
    isConfigured: () => options.configured ?? true,
    probe: async () => ({ provider: key, configured: true, apiAccessible: true }),
    findPeople: vi.fn(async () => {
      if (options.throws) throw new Error(options.throws);
      return people;
    }),
  };
}

function person(overrides: Partial<FoundPerson> = {}): FoundPerson {
  return {
    fullName: "Ana Popescu",
    title: "Director General",
    email: "ana.popescu@firma.ro",
    emailConfidence: 0.92,
    provider: "vendor",
    ...overrides,
  };
}

function ledger(limits: Record<string, number> = {}) {
  return new CreditLedger(new MemoryUsageStore(limits), "org-1");
}

describe("EmailWaterfall — domain gating", () => {
  it("spends nothing when the domain accepts no mail", async () => {
    // The single most valuable early exit: no MX means every later step is
    // pointless, and skipping them saves credits rather than spending them.
    const provider = fakeProvider("hunter", [person()]);
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      mx: fakeMx({ acceptsMail: false }),
      providers: [provider],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "dead-domain.ro",
    });

    expect(result.email).toBeNull();
    expect(provider.findPeople).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: "mx", outcome: "miss" }),
    ]);
  });

  it("continues when the MX lookup itself fails", async () => {
    // A resolver hiccup is not evidence the domain is dead; failing closed
    // here would silently drop good leads.
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      mx: fakeMx({ error: "resolver timed out" }),
      providers: [fakeProvider("hunter", [person()])],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.email?.address).toBe("ana.popescu@firma.ro");
    expect(result.attempts[0]).toMatchObject({ provider: "mx", outcome: "error" });
  });
});

describe("EmailWaterfall — free steps first", () => {
  it("infers the company pattern and skips vendors when confident enough", async () => {
    const provider = fakeProvider("hunter", [person()]);
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [provider],
    });

    const result = await waterfall.resolve({
      fullName: "Mihai Ionescu",
      domain: "firma.ro",
      knownContacts: [
        { email: "ana.popescu@firma.ro", fullName: "Ana Popescu" },
        { email: "elena.radu@firma.ro", fullName: "Elena Radu" },
        { email: "radu.stan@firma.ro", fullName: "Radu Stan" },
      ],
      targetConfidence: 0.7,
    });

    expect(result.email?.address).toBe("mihai.ionescu@firma.ro");
    expect(result.email?.provider).toBe("pattern");
    // The point of the free step: no paid lookup was needed.
    expect(provider.findPeople).not.toHaveBeenCalled();
  });

  it("never labels a pattern-derived address as verified", async () => {
    // Sending to a guess is how a sending domain's reputation gets burned.
    const waterfall = new EmailWaterfall({ ledger: ledger() });

    const result = await waterfall.resolve({
      fullName: "Mihai Ionescu",
      domain: "firma.ro",
      knownContacts: [
        { email: "ana.popescu@firma.ro", fullName: "Ana Popescu" },
        { email: "elena.radu@firma.ro", fullName: "Elena Radu" },
        { email: "radu.stan@firma.ro", fullName: "Radu Stan" },
      ],
    });

    expect(result.email?.status).toBe("pattern");
    expect(result.email?.status).not.toBe("verified");
  });

  it("keeps role addresses as alternatives rather than the primary result", async () => {
    // office@ reaches the company, not the person — but it is the address the
    // Romanian compliance path prefers, so it must survive the chain.
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("hunter", [person()])],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
      knownRoleEmails: ["office@firma.ro"],
    });

    expect(result.email?.address).toBe("ana.popescu@firma.ro");
    expect(result.alternatives.map((a) => a.address)).toContain("office@firma.ro");
  });

  it("falls back to a role address when nothing better exists", async () => {
    const waterfall = new EmailWaterfall({ ledger: ledger() });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
      knownRoleEmails: ["office@firma.ro"],
      targetConfidence: 0.5,
    });

    expect(result.email).toMatchObject({
      address: "office@firma.ro",
      isRoleAddress: true,
    });
  });
});

describe("EmailWaterfall — vendor steps", () => {
  it("matches the right person and records the hit", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [
        fakeProvider("hunter", [
          person({ fullName: "Elena Radu", email: "elena.radu@firma.ro" }),
          person({ fullName: "Ana Popescu", email: "ana.popescu@firma.ro" }),
        ]),
      ],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.email?.address).toBe("ana.popescu@firma.ro");
    expect(result.email?.status).toBe("verified");
  });

  it("matches through diacritics and middle names", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [
        fakeProvider("hunter", [
          person({ fullName: "Ionuț Ștefănescu", email: "i.s@firma.ro" }),
        ]),
      ],
    });

    const result = await waterfall.resolve({
      fullName: "Ionut Marian Stefanescu",
      domain: "firma.ro",
    });

    expect(result.email?.address).toBe("i.s@firma.ro");
  });

  it("skips a provider whose free tier is exhausted", async () => {
    const store = new MemoryUsageStore({ hunter: 2 });
    await store.increment("org-1", "hunter", currentMonth(), 2);

    const hunter = fakeProvider("hunter", [person()]);
    const waterfall = new EmailWaterfall({
      ledger: new CreditLedger(store, "org-1"),
      providers: [hunter],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(hunter.findPeople).not.toHaveBeenCalled();
    expect(result.attempts).toContainEqual(
      expect.objectContaining({
        provider: "hunter",
        outcome: "skipped",
        detail: expect.stringContaining("exhausted"),
      }),
    );
  });

  it("skips an unconfigured provider without counting it as a miss", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("prospeo", [], { configured: false })],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.attempts).toContainEqual(
      expect.objectContaining({ provider: "prospeo", outcome: "skipped" }),
    );
  });

  it("carries on to the next provider when one throws", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [
        fakeProvider("hunter", [], { throws: "429 rate limited" }),
        fakeProvider("prospeo", [person()]),
      ],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.email?.provider).toBe("prospeo");
    expect(result.attempts).toContainEqual(
      expect.objectContaining({ provider: "hunter", outcome: "error" }),
    );
  });

  it("stops at the first provider good enough", async () => {
    const second = fakeProvider("prospeo", [person()]);
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("hunter", [person()]), second],
    });

    await waterfall.resolve({ fullName: "Ana Popescu", domain: "firma.ro" });
    expect(second.findPeople).not.toHaveBeenCalled();
  });

  it("records a credit spent even when the lookup misses", async () => {
    // A miss costs the same as a hit. Not recording it is how a free tier
    // gets silently overspent.
    const store = new MemoryUsageStore({ hunter: 25 });
    const waterfall = new EmailWaterfall({
      ledger: new CreditLedger(store, "org-1"),
      providers: [fakeProvider("hunter", [])],
    });

    await waterfall.resolve({ fullName: "Ana Popescu", domain: "firma.ro" });

    const record = await store.get("org-1", "hunter", currentMonth());
    expect(record?.creditsUsed).toBe(1);
  });
});

describe("EmailWaterfall — verification", () => {
  const verifier = (status: "verified" | "invalid" | "risky"): MailboxVerifier => ({
    key: "verifier",
    verify: async (address) => ({ address, status }),
  });

  it("promotes a confirmed address", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("hunter", [person({ emailConfidence: 0.8 })])],
      verifier: verifier("verified"),
      // Force the verifier to run rather than short-circuiting on the vendor.
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
      targetConfidence: 0.99,
    });

    expect(result.email?.status).toBe("verified");
    expect(result.email?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("demotes an address the verifier rejects instead of deleting it", async () => {
    // A human may still want to look at it; nothing should auto-send to it.
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("hunter", [person()])],
      verifier: verifier("invalid"),
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
      targetConfidence: 0.99,
    });

    expect(result.email?.status).toBe("invalid");
    expect(result.email?.confidence).toBeLessThan(0.1);
  });

  it("caps confidence on a risky address", async () => {
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      providers: [fakeProvider("hunter", [person()])],
      verifier: verifier("risky"),
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
      targetConfidence: 0.99,
    });

    expect(result.email?.status).toBe("risky");
    expect(result.email?.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe("EmailWaterfall — last resort", () => {
  it("returns guesses as alternatives but never as the result", async () => {
    // The invariant that keeps an unverified guess out of the send queue.
    const waterfall = new EmailWaterfall({ ledger: ledger() });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.email).toBeNull();
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives[0].address).toBe("ana.popescu@firma.ro");
    expect(result.alternatives.every((a) => a.confidence < 0.4)).toBe(true);
  });

  it("reports cleanly when no candidate can be built at all", async () => {
    const waterfall = new EmailWaterfall({ ledger: ledger() });

    const result = await waterfall.resolve({ fullName: "   ", domain: "firma.ro" });

    expect(result.email).toBeNull();
    expect(result.alternatives).toEqual([]);
    expect(result.attempts).toContainEqual(
      expect.objectContaining({ provider: "pattern-guess", outcome: "miss" }),
    );
  });

  it("keeps the attempt log ordered cheapest-first", async () => {
    // The log is the audit trail the UI renders; its order is the explanation.
    const waterfall = new EmailWaterfall({
      ledger: ledger(),
      mx: fakeMx({ acceptsMail: true }),
      providers: [fakeProvider("hunter", [])],
    });

    const result = await waterfall.resolve({
      fullName: "Ana Popescu",
      domain: "firma.ro",
    });

    expect(result.attempts.map((a) => a.provider)).toEqual([
      "mx",
      "pattern",
      "hunter",
      "pattern-guess",
    ]);
  });
});

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
