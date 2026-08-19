import { describe, expect, it } from "vitest";
import { SCORE_BANDS, bandFor, flamesFor } from "./score";

describe("flamesFor", () => {
  it("lights all three at the hot threshold", () => {
    expect(flamesFor(SCORE_BANDS.hot)).toBe(3);
    expect(flamesFor(100)).toBe(3);
  });

  it("lights two from the warm threshold up to hot", () => {
    expect(flamesFor(SCORE_BANDS.warm)).toBe(2);
    expect(flamesFor(SCORE_BANDS.hot - 1)).toBe(2);
  });

  it("lights one below warm, including zero", () => {
    expect(flamesFor(SCORE_BANDS.warm - 1)).toBe(1);
    expect(flamesFor(0)).toBe(1);
  });

  it("never returns zero flames, so a row is never blank", () => {
    for (let score = 0; score <= 100; score += 1) {
      expect(flamesFor(score)).toBeGreaterThanOrEqual(1);
    }
  });

  it("agrees with bandFor at every score", () => {
    const expected = { cold: 1, warm: 2, hot: 3 } as const;
    for (let score = 0; score <= 100; score += 1) {
      expect(flamesFor(score)).toBe(expected[bandFor(score)]);
    }
  });
});
