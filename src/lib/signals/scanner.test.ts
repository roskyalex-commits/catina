import { describe, expect, it, vi } from "vitest";
import { SignalScanner } from "./scanner";
import type { Signal, SignalScanContext, SignalSource } from "./types";
import type { SourcedCompany } from "@/lib/sources/types";

/**
 * The scanner's job is isolation. Sources are independent and network-bound,
 * so a company with a working ANAF filing and a dead careers page must still
 * get its revenue signal.
 */

const company: SourcedCompany = {
  dedupeKey: "firma.ro",
  name: "Firma Test SRL",
  domain: "firma.ro",
  country: "RO",
  cui: "12345678",
  source: "anaf",
};

const context: SignalScanContext = { company };

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    type: "hiring_surge",
    title: "3 new roles",
    strength: 0.5,
    detectedAt: new Date(),
    dedupeKey: "k",
    ...overrides,
  };
}

function source(
  key: string,
  behaviour: {
    signals?: Signal[];
    throws?: string;
    applicable?: boolean;
    delayMs?: number;
  } = {},
): SignalSource {
  return {
    key,
    label: key,
    description: "",
    isApplicable: () => behaviour.applicable ?? true,
    scan: vi.fn(async () => {
      if (behaviour.delayMs) {
        await new Promise((r) => setTimeout(r, behaviour.delayMs));
      }
      if (behaviour.throws) throw new Error(behaviour.throws);
      return behaviour.signals ?? [];
    }),
  };
}

describe("SignalScanner", () => {
  it("collects signals from every applicable source", async () => {
    const scanner = new SignalScanner([
      source("a", { signals: [signal({ dedupeKey: "a" })] }),
      source("b", { signals: [signal({ dedupeKey: "b" })] }),
    ]);

    const result = await scanner.scan(context);
    expect(result.signals).toHaveLength(2);
    expect(result.sourceResults.every((r) => r.status === "ok")).toBe(true);
  });

  it("keeps going when one source throws", async () => {
    // The central guarantee: one broken source costs one source, not the scan.
    const scanner = new SignalScanner([
      source("broken", { throws: "careers page 500" }),
      source("working", { signals: [signal({ dedupeKey: "w" })] }),
    ]);

    const result = await scanner.scan(context);
    expect(result.signals).toHaveLength(1);
    expect(result.sourceResults).toContainEqual(
      expect.objectContaining({
        source: "broken",
        status: "error",
        detail: "careers page 500",
      }),
    );
  });

  it("records a skipped source distinctly from a failed one", async () => {
    // "Not applicable" is not a fault; conflating them would make a
    // non-Romanian company look like a broken integration.
    const scanner = new SignalScanner([source("anaf", { applicable: false })]);

    const result = await scanner.scan(context);
    expect(result.sourceResults[0]).toMatchObject({
      source: "anaf",
      status: "skipped",
    });
  });

  it("does not call scan on an inapplicable source", async () => {
    const skipped = source("anaf", { applicable: false });
    await new SignalScanner([skipped]).scan(context);
    expect(skipped.scan).not.toHaveBeenCalled();
  });

  it("times out a hanging source without losing the others", async () => {
    vi.useFakeTimers();
    const scanner = new SignalScanner([
      source("slow", { delayMs: 60_000 }),
      source("fast", { signals: [signal({ dedupeKey: "f" })] }),
    ]);

    const promise = scanner.scan(context);
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.signals).toHaveLength(1);
    expect(result.sourceResults[0]).toMatchObject({
      source: "slow",
      status: "error",
      detail: expect.stringContaining("timed out"),
    });
  });

  it("collapses duplicate events, keeping the stronger", async () => {
    // A funding round can surface as both news and a hiring surge.
    const scanner = new SignalScanner([
      source("news", { signals: [signal({ dedupeKey: "same", strength: 0.4 })] }),
      source("hiring", { signals: [signal({ dedupeKey: "same", strength: 0.9 })] }),
    ]);

    const result = await scanner.scan(context);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].strength).toBe(0.9);
  });

  it("returns signals strongest first", async () => {
    const scanner = new SignalScanner([
      source("a", { signals: [signal({ dedupeKey: "weak", strength: 0.2 })] }),
      source("b", { signals: [signal({ dedupeKey: "strong", strength: 0.9 })] }),
    ]);

    const result = await scanner.scan(context);
    expect(result.signals.map((s) => s.dedupeKey)).toEqual(["strong", "weak"]);
  });

  it("returns an empty outcome for no sources", async () => {
    const result = await new SignalScanner([]).scan(context);
    expect(result).toEqual({ signals: [], sourceResults: [] });
  });
});
