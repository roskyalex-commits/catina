/**
 * SVG path maths for the area charts.
 *
 * Kept pure and separate from the component for two reasons: it is the only
 * part with real arithmetic worth testing, and it lets the chart render on the
 * server with no client bundle beyond the markup.
 *
 * Interpolation is monotone cubic (Fritsch-Carlson), not a plain Catmull-Rom.
 * Every series here is a count, so a spline that overshoots below zero would
 * draw a curve claiming negative leads between two real days. Monotone cubic
 * cannot overshoot between points, which is exactly the guarantee needed.
 */

export type Point = { x: number; y: number };

export type ChartGeometry = {
  width: number;
  height: number;
  /** Space reserved below the plot for x-axis labels. */
  padBottom: number;
  padTop: number;
};

export const DEFAULT_GEOMETRY: ChartGeometry = {
  width: 1000,
  height: 260,
  padBottom: 28,
  padTop: 8,
};

/**
 * Highest value across every series, rounded up to something a human would put
 * on an axis. Shared across series so the lines stay comparable.
 */
export function niceMax(seriesValues: number[][]): number {
  const max = Math.max(0, ...seriesValues.flat());
  if (max === 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(max));
  // 1.5 earns its place: without it a peak of 118 gets a 200 axis and the
  // curve sits in the bottom half of the card.
  for (const step of [1, 1.5, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= max) return candidate;
  }
  return 10 * magnitude;
}

export function toPoints(
  values: number[],
  max: number,
  geometry: ChartGeometry = DEFAULT_GEOMETRY,
): Point[] {
  const { width, height, padBottom, padTop } = geometry;
  const plotHeight = height - padBottom - padTop;
  const denominator = max <= 0 ? 1 : max;

  if (values.length === 0) return [];
  if (values.length === 1) {
    const only = values[0] ?? 0;
    const y = padTop + plotHeight * (1 - only / denominator);
    // A single reading is drawn as a flat line rather than a dot, so the
    // series still reads as a series.
    return [
      { x: 0, y },
      { x: width, y },
    ];
  }

  const step = width / (values.length - 1);
  return values.map((value, i) => ({
    x: i * step,
    y: padTop + plotHeight * (1 - (value ?? 0) / denominator),
  }));
}

/** Fritsch-Carlson tangents: monotone, so the curve never leaves the data's range. */
function tangents(points: Point[]): number[] {
  const n = points.length;
  const deltas: number[] = [];

  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    deltas.push(dx === 0 ? 0 : (points[i + 1]!.y - points[i]!.y) / dx);
  }

  const m: number[] = new Array(n).fill(0);
  m[0] = deltas[0] ?? 0;
  m[n - 1] = deltas[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const prev = deltas[i - 1] ?? 0;
    const next = deltas[i] ?? 0;
    // A local extremum gets a flat tangent — this is what stops the overshoot.
    m[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }

  for (let i = 0; i < n - 1; i += 1) {
    const delta = deltas[i] ?? 0;
    if (delta === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = (m[i] ?? 0) / delta;
    const beta = (m[i + 1] ?? 0) / delta;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      m[i] = scale * alpha * delta;
      m[i + 1] = scale * beta * delta;
    }
  }

  return m;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function buildLinePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;

  const m = tangents(points);
  let d = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const dx = (p1.x - p0.x) / 3;
    d +=
      ` C ${round(p0.x + dx)} ${round(p0.y + (m[i] ?? 0) * dx)}` +
      ` ${round(p1.x - dx)} ${round(p1.y - (m[i + 1] ?? 0) * dx)}` +
      ` ${round(p1.x)} ${round(p1.y)}`;
  }

  return d;
}

/** The line, closed down to the baseline, for the tinted fill beneath it. */
export function buildAreaPath(
  points: Point[],
  geometry: ChartGeometry = DEFAULT_GEOMETRY,
): string {
  if (points.length === 0) return "";
  const baseline = geometry.height - geometry.padBottom;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    `${buildLinePath(points)} L ${round(last.x)} ${round(baseline)}` +
    ` L ${round(first.x)} ${round(baseline)} Z`
  );
}
