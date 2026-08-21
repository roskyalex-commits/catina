import { afterEach, describe, expect, it, vi } from "vitest";
import { allVerifiers, preferredVerifier } from "./registry";
import { ReoonVerifier } from "./reoon";

/**
 * What is worth pinning here is the *mapping*, not the HTTP call. Reoon's
 * vocabulary has nine power-mode statuses and ours has four, and every
 * collapsing decision in between is one where a wrong answer either burns a
 * sending domain or silently deletes a good address.
 */

function respondWith(body: unknown, ok = true) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status: ok ? 200 : 402 }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("mapping Reoon's verdicts onto ours", () => {
  it("promotes a confirmed mailbox", async () => {
    respondWith({ status: "safe" });
    const verdict = await new ReoonVerifier("k").verify("ion@firma.ro");
    expect(verdict.status).toBe("verified");
  });

  it("refuses to call a catch-all domain verified", async () => {
    /*
     * The single most important line in this file. A catch-all host accepts
     * every recipient, so the probe succeeded and proved nothing. Promoting it
     * would mark every generated address at every shared-hosting domain in
     * Romania as confirmed — and Romanian SMBs are overwhelmingly on shared
     * hosting.
     */
    respondWith({ status: "catch_all", is_catch_all: true });
    const verdict = await new ReoonVerifier("k").verify("ion@firma.ro");
    expect(verdict.status).toBe("risky");
    expect(verdict.isCatchAll).toBe(true);
  });

  it("treats a disabled or trapped mailbox as invalid", async () => {
    for (const status of ["invalid", "disabled", "spamtrap", "disposable"]) {
      respondWith({ status });
      const verdict = await new ReoonVerifier("k").verify("ion@firma.ro");
      expect(verdict.status, status).toBe("invalid");
    }
  });

  it("treats a full inbox as risky — it is real, but not sendable today", async () => {
    respondWith({ status: "inbox_full" });
    expect((await new ReoonVerifier("k").verify("ion@firma.ro")).status).toBe("risky");
  });

  it("accepts a confirmed role mailbox", async () => {
    // Reoon labels these instead of returning `safe`, and role addresses are
    // the ones this product prefers for Romanian outreach.
    respondWith({ status: "role_account", is_role_account: true });
    expect((await new ReoonVerifier("k").verify("office@firma.ro")).status).toBe(
      "verified",
    );
  });

  it("keeps the vendor's own word in the reason", async () => {
    respondWith({ status: "catch_all" });
    const verdict = await new ReoonVerifier("k").verify("ion@firma.ro");
    // `risky` alone hides whether this was a catch-all or a full inbox, which
    // is the first thing anyone debugging a lead wants to know.
    expect(verdict.reason).toContain("catch_all");
  });
});

describe("a failure must not look like a verdict", () => {
  it("returns unknown, not invalid, when the quota is gone", async () => {
    /*
     * An exhausted quota says nothing about the address. Returning `invalid`
     * would let a billing problem quietly demote every address it touched —
     * and the demotion is persisted, so it would outlive the outage.
     */
    respondWith({ error: "insufficient credits" }, false);
    const verdict = await new ReoonVerifier("k").verify("ion@firma.ro");
    expect(verdict.status).toBe("unknown");
    expect(verdict.reason).toContain("insufficient credits");
  });

  it("returns unknown when the network fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    expect((await new ReoonVerifier("k").verify("ion@firma.ro")).status).toBe("unknown");
  });

  it("returns unknown for an unrecognised status rather than assuming", async () => {
    respondWith({ status: "something_new" });
    expect((await new ReoonVerifier("k").verify("ion@firma.ro")).status).toBe("unknown");
  });

  it("does not call out at all when no key is set", async () => {
    const spy = respondWith({ status: "safe" });
    const verdict = await new ReoonVerifier(undefined).verify("ion@firma.ro");
    expect(verdict.status).toBe("unknown");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("quick mode cannot confirm a mailbox, and says so", () => {
  it("declares that it does not check the inbox", () => {
    /*
     * The property the waterfall gates on. Reoon's own docs: "all emails
     * including non-existing ones from that domain will be marked as valid".
     */
    expect(new ReoonVerifier("k", "quick").verifiesMailbox).toBe(false);
    expect(new ReoonVerifier("k", "power").verifiesMailbox).toBe(true);
    expect(new ReoonVerifier("k").verifiesMailbox).toBe(true);
  });

  it("maps quick mode's `valid` to risky, never verified", async () => {
    /*
     * `valid` here means the domain accepts mail, which `MxChecker` already
     * establishes for free. Mapping it to `verified` would mark every guessed
     * address at every live domain as confirmed — so even a caller that forgot
     * to check `verifiesMailbox` cannot get a confirmation out of quick mode.
     */
    respondWith({ status: "valid", mx_accepts_mail: true });
    const verdict = await new ReoonVerifier("k", "quick").verify("ion@firma.ro");
    expect(verdict.status).toBe("risky");
  });

  it("still catches the things MX records cannot reveal", async () => {
    // What quick mode is actually for: screening addresses already known real.
    for (const status of ["spamtrap", "disposable", "invalid"]) {
      respondWith({ status });
      const verdict = await new ReoonVerifier("k", "quick").verify("ion@firma.ro");
      expect(verdict.status, status).toBe("invalid");
    }
  });

  it("names the mode in the reason, so a `valid` cannot read as a confirmation", async () => {
    respondWith({ status: "valid" });
    const verdict = await new ReoonVerifier("k", "quick").verify("ion@firma.ro");
    expect(verdict.reason).toContain("quick");
  });

  it("treats an unrecognised mode string as power", () => {
    // Fail towards the mode that is safe to act on.
    expect(new ReoonVerifier("k", "").verifiesMailbox).toBe(true);
    expect(new ReoonVerifier("k", "turbo").verifiesMailbox).toBe(true);
  });
});

describe("the registry", () => {
  it("treats a blank key as no key at all", () => {
    // dotenv parses `REOON_API_KEY=` as `""`, and `.env.example` ships it blank.
    expect(preferredVerifier({ REOON_API_KEY: "" })).toBeNull();
    expect(preferredVerifier({ REOON_API_KEY: "   " })).toBeNull();
  });

  it("returns null when nothing is configured, which is a supported state", () => {
    expect(preferredVerifier({})).toBeNull();
  });

  it("selects Reoon when its key is present", () => {
    expect(preferredVerifier({ REOON_API_KEY: "k" })?.key).toBe("reoon");
  });

  it("passes the mode through from the environment", () => {
    expect(
      preferredVerifier({ REOON_API_KEY: "k", REOON_MODE: "quick" })?.verifiesMailbox,
    ).toBe(false);
    expect(preferredVerifier({ REOON_API_KEY: "k" })?.verifiesMailbox).toBe(true);
  });

  it("lists unconfigured providers so a setup screen can name them", () => {
    expect(allVerifiers({}).map((verifier) => verifier.key)).toEqual(["reoon"]);
    expect(allVerifiers({})[0].label).toMatch(/REOON_API_KEY/);
  });
});
