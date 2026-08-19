"use client";

import { useId, useMemo, useState } from "react";
import {
  DEFAULT_GEOMETRY,
  buildAreaPath,
  buildLinePath,
  niceMax,
  toPoints,
} from "./path";
import type { ChartData } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * Multi-series area chart.
 *
 * Hand-rolled rather than pulled from a library: this is ~150 lines against
 * ~100KB of client JavaScript for Recharts, it renders its own markup so the
 * server does the work, and it gives exact control over the curve — which
 * matters, because matching a reference design is the acceptance criterion.
 *
 * Accessibility: the SVG is `aria-hidden` and the same numbers are emitted as a
 * visually-hidden table. A screen reader gets the data, not a description of a
 * picture.
 */
export function AreaChart({
  data,
  height = 260,
  className,
}: {
  data: ChartData;
  height?: number;
  className?: string;
}) {
  const uid = useId().replace(/[:]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  // Labels render as HTML below the plot, so the SVG needs no bottom gutter.
  const geometry = { ...DEFAULT_GEOMETRY, height, padBottom: 2 };
  const max = useMemo(
    () => niceMax(data.series.map((s) => s.points)),
    [data.series],
  );

  const plotted = useMemo(
    () =>
      data.series.map((series) => ({
        ...series,
        points: toPoints(series.points, max, geometry),
      })),
    // geometry is derived from `height`, which is the only mutable part.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.series, max, height],
  );

  const count = data.labels.length;
  const baseline = geometry.height - geometry.padBottom;
  const step = count > 1 ? geometry.width / (count - 1) : geometry.width;

  // Roughly one label per 90px of a 1000-unit viewBox, so a 90-day range does
  // not overprint its axis.
  const labelEvery = Math.max(1, Math.ceil(count / 11));

  /** The labels the axis shows, and which of them survive on a narrow screen. */
  const axisLabels = data.labels
    .map((label, index) => ({ label, index }))
    .filter(({ index }) => index % labelEvery === 0 || index === count - 1)
    .map(({ label, index }, position, shown) => ({
      label,
      index,
      onMobile:
        position % Math.max(1, Math.ceil(shown.length / 4)) === 0 ||
        position === shown.length - 1,
    }));

  return (
    <figure className={cn("m-0", className)}>
      <figcaption className="mb-4 flex flex-wrap items-center justify-end gap-x-5 gap-y-2">
        {data.series.map((series) => (
          <span
            key={series.key}
            className="flex items-center gap-2 text-[13px] text-muted"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: `var(${series.color})` }}
            />
            {series.label}
          </span>
        ))}
      </figcaption>

      <div className="relative pl-9">
        {/* Value axis: top, middle, baseline.
            Quarters would read 113 / 75 / 38 on a 150 axis — technically right
            and useless to scan. Halves stay round for every axis maximum the
            nice-number search can produce. */}
        <div
          className="absolute left-0 top-0 flex w-8 flex-col justify-between text-right text-[11px] tabular-nums text-muted"
          style={{ height }}
          aria-hidden
        >
          {[1, 0.5, 0].map((fraction) => (
            <span key={fraction}>{Math.round(max * fraction)}</span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="none"
          className="w-full"
          style={{ height }}
          aria-hidden
          focusable="false"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            if (box.width === 0 || count === 0) return;
            const ratio = (event.clientX - box.left) / box.width;
            setHover(
              Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1)))),
            );
          }}
        >
          <defs>
            {plotted.map((series) => (
              <linearGradient
                key={series.key}
                id={`${uid}-${series.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={`var(${series.color})`} stopOpacity="0.18" />
                <stop offset="100%" stopColor={`var(${series.color})`} stopOpacity="0" />
              </linearGradient>
            ))}
          </defs>

          {/* Four gridlines: enough to read a value against, few enough to
              stay out of the way of the curves. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = geometry.padTop + (baseline - geometry.padTop) * fraction;
            return (
              <line
                key={fraction}
                x1="0"
                x2={geometry.width}
                y1={y}
                y2={y}
                stroke="var(--border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {plotted.map((series) => (
            <g key={series.key}>
              <path
                d={buildAreaPath(series.points, geometry)}
                fill={`url(#${uid}-${series.key})`}
              />
              <path
                d={buildLinePath(series.points)}
                fill="none"
                stroke={`var(${series.color})`}
                strokeWidth="2"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}

          {hover !== null && (
            <g>
              <line
                x1={hover * step}
                x2={hover * step}
                y1={geometry.padTop}
                y2={baseline}
                stroke="var(--border-strong)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              {plotted.map((series) => {
                const point = series.points[hover];
                if (!point) return null;
                return (
                  <circle
                    key={series.key}
                    cx={point.x}
                    cy={point.y}
                    r="3"
                    fill="var(--surface)"
                    stroke={`var(${series.color})`}
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>
          )}
        </svg>

        {/* Axis labels are HTML, not SVG <text>: the viewBox is stretched
            horizontally by preserveAspectRatio="none" to fill the container,
            and that would stretch glyphs with it. */}
        <div className="mt-1 flex justify-between text-[11px] text-muted">
          {axisLabels.map(({ label, index, onMobile }) => (
            <span
              key={`${label}-${index}`}
              className={cn(
                "whitespace-nowrap",
                // `labelEvery` is tuned for a chart around 1000px wide. The
                // same row on a phone is roughly 300px, where eleven nowrap
                // labels do not fit: `justify-between` pushes the last ones
                // past the edge and the whole page gains a horizontal
                // scrollbar. Thin them here and restore the rest at `sm`.
                !onMobile && "hidden sm:inline",
              )}
            >
              {label}
            </span>
          ))}
        </div>

        {hover !== null && data.labels[hover] && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 text-xs shadow-sm"
            style={{
              left: `${count > 1 ? (hover / (count - 1)) * 100 : 50}%`,
              transform: "translateX(-50%)",
            }}
          >
            <p className="mb-1 font-medium">{data.labels[hover]}</p>
            <ul className="space-y-0.5">
              {data.series.map((series) => (
                <li key={series.key} className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: `var(${series.color})` }}
                  />
                  <span className="text-muted">{series.label}</span>
                  <span className="ml-auto tabular-nums">
                    {series.points[hover] ?? 0}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/*
        The table is the accessible alternative to the plot. It sits inside a
        `sr-only` **div** rather than carrying the class itself: `sr-only` pins
        width to 1px, and a `<table>` treats that as a minimum and expands to
        its content anyway. Absolutely positioned and several hundred pixels
        wide, it then stretched the document and gave every page with a chart a
        horizontal scrollbar. A div honours the 1px and clips it.
      */}
      <div className="sr-only">
        <table>
          <caption>Activity by day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {data.series.map((series) => (
              <th key={series.key} scope="col">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.labels.map((label, i) => (
            <tr key={`${label}-${i}`}>
              <th scope="row">{label}</th>
              {data.series.map((series) => (
                <td key={series.key}>{series.points[i] ?? 0}</td>
              ))}
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
