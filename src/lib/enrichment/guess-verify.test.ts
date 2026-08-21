import { describe, expect, it, vi } from "vitest";
import { CreditLedger, MemoryUsageStore } from "./ledger";
import type { MailboxVerifier, VerificationVerdict } from "./mx";
import { EmailWaterfall } from "./waterfall";

/**
 * Guess-and-verify: the step that makes a domain with no learned convention
 * reachable at all.
 *
 * Per-company pattern inference fires on ~2.5% of Romanian domains — measured,
 * see docs/STATUS.md. For the other 97.5% there is no evidence to read, only
 * the prevalence order, which leads with `first.last`. A guess is not an
 * answer; a guess a mailbox confirms is. This is where that happens, and the
 * credit economics are the part worth pinning, because the free tier is 600
 * checks a month and this step would otherwise eat it.
 */

function verifierReturning(
  verdicts: VerificationVerdict["status"][],
  extra: Partial<VerificationVerdict> = {},
): MailboxVerifier & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    key: "verifier",
    label: "stub",
    calls,
    isConfigured: () => true,
    verify: async (address) => {
      calls.push(address);
      const status = verdicts[Math.min(index, verdicts.length - 1)];
      index += 1;
      return { address, status, ...extra };
    },
  };
}

function build(verifier?: MailboxVerifier, limits: Record<string, number> = {}) {
  return new EmailWaterfall({
    ledger: new CreditLedger(new MemoryUsageStore(limits), "org-1"),
    verifier,
  });
}

const ANA = {
  fullName: "Popescu Ana",
  domain: "firma.ro",
  nameParts: { firstName: "ana", lastName: "popescu" },
};

describe("a guess the mailbox confirms becomes a real address", () => {
  it("promotes the first convention that verifies", async () => {
    const verifier = verifierReturning(["verified"]);
    const result = await build(verifier).resolve(ANA);

    expect(result.email?.status).toBe("verified");
    // `first.last` leads `PATTERNS_BY_PREVALENCE`, and it is what the reference
    // product produces for every lead the user checked.
    expect(result.email?.address).toBe("ana.popescu@firma.ro");
    expect(result.email?.provider).toBe("pattern-verified");
  });

  it("moves on to the next convention when the first is rejected", async () => {
    // `invalid` is real progress: the host answered, and said no to that
    // recipient. The second convention is worth a credit.
    const verifier = verifierReturning(["invalid", "verified"]);
    const result = await build(verifier).resolve(ANA);

    expect(verifier.calls).toHaveLength(2);
    expect(result.email?.status).toBe("verified");
    expect(result.email?.address).not.toBe("ana.popescu@firma.ro");
  });

  it("records the spend, so a bulk run cannot silently exceed the free tier", async () => {
    const store = new MemoryUsageStore({ verifier: 600 });
    const waterfall = new EmailWaterfall({
      ledger: new CreditLedger(store, "org-1"),
      verifier: verifierReturning(["verified"]),
    });

    await waterfall.resolve(ANA);

    expect((await store.get("org-1", "verifier", currentMonth()))?.creditsUsed).toBe(1);
  });
});

describe("what stops it burning credits", () => {
  it("stops dead on a catch-all domain", async () => {
    /*
     * The most important economy in the file. A catch-all host accepts every
     * recipient, so guesses two and three return the identical non-answer.
     * Trying them spends two more credits to learn nothing — and Romanian SMBs
     * are overwhelmingly on shared hosting that behaves this way, so without
     * this the free tier would be gone in a couple of hundred leads.
     */
    const verifier = verifierReturning(["risky"], { isCatchAll: true });
    const result = await build(verifier).resolve(ANA);

    expect(verifier.calls).toHaveLength(1);
    expect(result.email).toBeNull();
  });

  it("stops on an unknown verdict rather than turning one failure into three", async () => {
    // `unknown` means the *check* failed — quota, network, vendor. The address
    // is not implicated, and hammering it proves nothing.
    const verifier = verifierReturning(["unknown"]);
    await build(verifier).resolve(ANA);

    expect(verifier.calls).toHaveLength(1);
  });

  it("does not start when the allowance is already spent", async () => {
    const verifier = verifierReturning(["verified"]);
    const result = await build(verifier, { verifier: 0 }).resolve(ANA);

    expect(verifier.calls).toHaveLength(0);
    expect(result.email).toBeNull();
    expect(
      result.attempts.some(
        (attempt) => attempt.provider === "verifier" && attempt.outcome === "skipped",
      ),
    ).toBe(true);
  });

  it("survives a verifier that throws, without claiming an address", async () => {
    const verifier: MailboxVerifier = {
      key: "verifier",
      label: "stub",
      isConfigured: () => true,
      verify: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    };
    const result = await build(verifier).resolve(ANA);

    expect(result.email).toBeNull();
    expect(
      result.attempts.some((attempt) => attempt.outcome === "error"),
    ).toBe(true);
  });
});

describe("without a verifier, nothing changes", () => {
  it("keeps guesses as alternatives and never returns one as the address", async () => {
    /*
     * The degradation path. A workspace with no verifier key still gets the
     * candidates for a human to look at, and the product never sends to one.
     * This is why the missing key is a limitation rather than a breakage.
     */
    const result = await build(undefined).resolve(ANA);

    expect(result.email).toBeNull();
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.alternatives.every((alt) => alt.status === "pattern")).toBe(true);
  });

  it("still refuses a name it could not resolve", async () => {
    // No parts, no address — the rule that keeps a stranger's name off an email
    // to their employer's domain.
    const result = await build(verifierReturning(["verified"])).resolve({
      fullName: "",
      domain: "firma.ro",
      nameParts: { firstName: undefined, lastName: undefined },
    });

    expect(result.email).toBeNull();
  });
});

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
