import { describe, expect, it } from "vitest";
import { PLANS, canUseFeature, checkQuota, isScanDue } from "./limits";

describe("plan shape", () => {
  it("keeps the free tier generous where our costs are zero", () => {
    // Sourcing from the Romanian registry costs nothing, so a free tier that
    // caps it at a demo-sized number would be a self-inflicted wound.
    expect(PLANS.free.maxCompanies).toBeGreaterThanOrEqual(1000);
    expect(PLANS.free.csvExport).toBe(true);
  });

  it("keeps the free tier tight where credits are actually spent", () => {
    expect(PLANS.free.maxEnrichmentsPerMonth).toBeLessThanOrEqual(100);
  });

  it("withholds auto-send on free", () => {
    // An unattended sender on an unverified account is how a shared sending
    // reputation gets burned.
    expect(PLANS.free.autoSend).toBe(false);
    expect(PLANS.pro.autoSend).toBe(true);
  });

  it("undercuts the competitor's price point", () => {
    expect(PLANS.pro.priceEurMonthly).toBeLessThan(99);
  });

  it("scans less often on free than on pro", () => {
    expect(PLANS.free.scanIntervalHours).toBeGreaterThan(
      PLANS.pro.scanIntervalHours,
    );
  });
});

describe("checkQuota", () => {
  it("allows a request within the limit", () => {
    const check = checkQuota("free", "enrichments", 10);
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(PLANS.free.maxEnrichmentsPerMonth - 10);
  });

  it("allows the request that exactly reaches the limit", () => {
    // Off-by-one guard: 49 used of 50 must still allow one more.
    const check = checkQuota("free", "enrichments", 49, 1);
    expect(check.allowed).toBe(true);
  });

  it("refuses the request that would exceed it", () => {
    const check = checkQuota("free", "enrichments", 50, 1);
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });

  it("accounts for a batch request, not just one unit", () => {
    // Enrichment runs in batches; checking one at a time would overshoot.
    expect(checkQuota("free", "enrichments", 45, 10).allowed).toBe(false);
    expect(checkQuota("free", "enrichments", 45, 5).allowed).toBe(true);
  });

  it("warns before refusing", () => {
    const check = checkQuota("free", "enrichments", 45);
    expect(check.allowed).toBe(true);
    expect(check.nearLimit).toBe(true);
    expect(check.message).toContain("left");
  });

  it("stays quiet well below the limit", () => {
    const check = checkQuota("free", "enrichments", 5);
    expect(check.nearLimit).toBe(false);
    expect(check.message).toBeUndefined();
  });

  it("names the specific resource rather than saying 'upgrade'", () => {
    const check = checkQuota("free", "mailboxes", 1, 1);
    expect(check.message).toContain("connected mailboxes");
  });

  it("tells a free user what Pro would give them", () => {
    const check = checkQuota("free", "enrichments", 50, 1);
    expect(check.message).toContain("Pro raises this to");
  });

  it("does not pitch Pro to a Pro user", () => {
    const check = checkQuota("pro", "enrichments", 2000, 1);
    expect(check.allowed).toBe(false);
    expect(check.message).not.toContain("Pro raises");
  });

  it("treats custom as effectively unlimited", () => {
    expect(checkQuota("custom", "companies", 10_000_000).allowed).toBe(true);
  });

  it("reports a fraction usable as a progress bar", () => {
    const check = checkQuota("free", "enrichments", 25);
    expect(check.fraction).toBeCloseTo(0.5);
  });

  it("never reports a fraction above 1 when over the limit", () => {
    expect(checkQuota("free", "enrichments", 500).fraction).toBe(1);
  });

  it("falls back to free limits for an unknown plan", () => {
    // A corrupt or missing plan value must fail closed, not open.
    const check = checkQuota("nonsense" as never, "enrichments", 60);
    expect(check.allowed).toBe(false);
  });
});

describe("canUseFeature", () => {
  it("gates auto-send by plan", () => {
    expect(canUseFeature("free", "autoSend")).toBe(false);
    expect(canUseFeature("pro", "autoSend")).toBe(true);
  });

  it("allows CSV export on every plan", () => {
    // Locking export would hold the user's own data hostage.
    expect(canUseFeature("free", "csvExport")).toBe(true);
  });

  it("fails closed on an unknown plan", () => {
    expect(canUseFeature("nonsense" as never, "autoSend")).toBe(false);
  });
});

describe("isScanDue", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("is due when never scanned", () => {
    expect(isScanDue("free", null, now)).toBe(true);
    expect(isScanDue("free", undefined, now)).toBe(true);
  });

  it("respects the free tier's daily interval", () => {
    expect(isScanDue("free", new Date("2026-06-01T02:00:00Z"), now)).toBe(false);
    expect(isScanDue("free", new Date("2026-05-31T11:00:00Z"), now)).toBe(true);
  });

  it("respects the pro tier's hourly interval", () => {
    expect(isScanDue("pro", new Date("2026-06-01T11:30:00Z"), now)).toBe(false);
    expect(isScanDue("pro", new Date("2026-06-01T10:30:00Z"), now)).toBe(true);
  });

  it("is due exactly at the interval boundary", () => {
    expect(isScanDue("pro", new Date("2026-06-01T11:00:00Z"), now)).toBe(true);
  });
});
