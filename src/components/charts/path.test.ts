import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEOMETRY,
  buildAreaPath,
  buildLinePath,
  niceMax,
  toPoints,
} from "./path";

const numbersIn = (d: string) =>
  (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("niceMax", () => {
  it("returns 1 for an all-zero chart rather than dividing by zero", () => {
    expect(niceMax([[0, 0, 0]])).toBe(1);
    expect(niceMax([[]])).toBe(1);
  });

  it("rounds up to a readable axis value", () => {
    expect(niceMax([[7]])).toBe(10);
    expect(niceMax([[42]])).toBe(50);
    expect(niceMax([[96]])).toBe(100);
    expect(niceMax([[210]])).toBe(250);
  });

  it("spans every series, so lines stay comparable", () => {
    expect(niceMax([[3, 4], [88]])).toBe(100);
  });

  it("never returns a max below the data", () => {
    for (const value of [1, 9, 11, 99, 101, 999, 1001, 12345]) {
      expect(niceMax([[value]])).toBeGreaterThanOrEqual(value);
    }
  });
});

describe("toPoints", () => {
  it("puts the maximum at the top of the plot and zero on the baseline", () => {
    const [low, high] = toPoints([0, 10], 10);
    expect(high!.y).toBeCloseTo(DEFAULT_GEOMETRY.padTop);
    expect(low!.y).toBeCloseTo(
      DEFAULT_GEOMETRY.height - DEFAULT_GEOMETRY.padBottom,
    );
  });

  it("spreads points evenly across the full width", () => {
    const points = toPoints([1, 2, 3, 4, 5], 5);
    expect(points[0]!.x).toBe(0);
    expect(points[4]!.x).toBe(DEFAULT_GEOMETRY.width);
    expect(points[2]!.x).toBe(DEFAULT_GEOMETRY.width / 2);
  });

  it("draws a single reading as a flat line, not a dot", () => {
    const points = toPoints([4], 10);
    expect(points).toHaveLength(2);
    expect(points[0]!.y).toBe(points[1]!.y);
  });

  it("returns nothing for no readings", () => {
    expect(toPoints([], 10)).toEqual([]);
  });
});

describe("buildLinePath", () => {
  it("is empty for no points", () => {
    expect(buildLinePath([])).toBe("");
  });

  it("starts with a move to the first point", () => {
    const d = buildLinePath(toPoints([0, 5, 10], 10));
    expect(d.startsWith("M 0 ")).toBe(true);
  });

  it("emits one cubic segment per gap", () => {
    const d = buildLinePath(toPoints([1, 2, 3, 4], 4));
    expect((d.match(/C/g) ?? []).length).toBe(3);
  });

  /**
   * The reason this file uses monotone cubic at all. A Catmull-Rom spline
   * through a spike overshoots on the way back down and draws the curve below
   * the baseline — a chart claiming negative leads.
   */
  it("never overshoots the data range around a spike", () => {
    const values = [0, 0, 96, 0, 0];
    const points = toPoints(values, 100);
    const top = DEFAULT_GEOMETRY.padTop;
    const baseline = DEFAULT_GEOMETRY.height - DEFAULT_GEOMETRY.padBottom;

    for (const n of numbersIn(buildLinePath(points))) {
      // x coordinates share the number stream; bound checks cover both axes.
      expect(n).toBeGreaterThanOrEqual(-0.01);
      if (n <= baseline + 0.01) continue;
      expect(n).toBeLessThanOrEqual(DEFAULT_GEOMETRY.width + 0.01);
    }

    const ys = numbersIn(buildLinePath(points)).filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(top - 0.01);
    expect(Math.max(...ys)).toBeLessThanOrEqual(baseline + 0.01);
  });

  it("keeps a flat series flat", () => {
    const points = toPoints([5, 5, 5, 5], 10);
    const ys = numbersIn(buildLinePath(points)).filter((_, i) => i % 2 === 1);
    for (const y of ys) expect(y).toBeCloseTo(ys[0]!);
  });
});

describe("buildAreaPath", () => {
  it("closes the shape down to the baseline", () => {
    const d = buildAreaPath(toPoints([2, 8, 4], 10));
    const baseline = DEFAULT_GEOMETRY.height - DEFAULT_GEOMETRY.padBottom;
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain(`L 0 ${baseline}`);
  });

  it("is empty for no points, so nothing paints", () => {
    expect(buildAreaPath([])).toBe("");
  });
});
