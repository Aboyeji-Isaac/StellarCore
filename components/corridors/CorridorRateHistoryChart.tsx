"use client";

import { useId, useState } from "react";
import type {
  PublicRateHistoryPoint,
  PublicRateHistoryResponse,
} from "@/types/api/rateHistory";

type Props = Readonly<{
  corridorSlug: string;
  initialHistory: PublicRateHistoryResponse;
}>;

const TIMEFRAME_OPTIONS = [
  { label: "7D", days: 7 },
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
] as const;

const SVG_WIDTH = 800;
const SVG_HEIGHT = 280;
const PADDING = { top: 25, right: 30, bottom: 45, left: 65 };
const CHART_WIDTH = SVG_WIDTH - PADDING.left - PADDING.right;
const CHART_HEIGHT = SVG_HEIGHT - PADDING.top - PADDING.bottom;
const GAP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function CorridorRateHistoryChart({
  corridorSlug,
  initialHistory,
}: Props) {
  const chartId = useId();
  const [history, setHistory] = useState<PublicRateHistoryResponse>(initialHistory);
  const [selectedDays, setSelectedDays] = useState<number>(initialHistory.windowDays);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  async function handleTimeframeChange(days: number) {
    if (days === selectedDays || loading) return;
    setSelectedDays(days);
    setLoading(true);
    setError(null);
    setHoveredPointIndex(null);

    try {
      const response = await fetch(
        `/api/rates/history?corridor=${encodeURIComponent(corridorSlug)}&days=${days}`,
      );
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.error?.message ?? "Unable to load rate history.",
        );
      }
      const data: PublicRateHistoryResponse = await response.json();
      setHistory(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load rate history.",
      );
    } finally {
      setLoading(false);
    }
  }

  const validPoints = history.points
    .map((point, index) => {
      const rateNum = point.medianRate !== null ? Number.parseFloat(point.medianRate) : null;
      const timeNum = new Date(point.timestamp).getTime();
      return {
        point,
        originalIndex: index,
        rate: rateNum,
        time: timeNum,
      };
    })
    .filter(
      (
        item,
      ): item is {
        point: PublicRateHistoryPoint;
        originalIndex: number;
        rate: number;
        time: number;
      } => item.rate !== null && Number.isFinite(item.rate) && Number.isFinite(item.time),
    );

  const evaluatedAtTime = new Date(history.evaluatedAt).getTime();
  const minWindowTime = evaluatedAtTime - selectedDays * 24 * 60 * 60 * 1000;
  const minTime = validPoints.length > 0
    ? Math.min(minWindowTime, validPoints[0]!.time)
    : minWindowTime;
  const maxTime = Math.max(evaluatedAtTime, validPoints.length > 0 ? validPoints[validPoints.length - 1]!.time : minWindowTime + 1);
  const timeSpan = Math.max(maxTime - minTime, 1);

  const rates = validPoints.map((p) => p.rate);
  const minRate = rates.length > 0 ? Math.min(...rates) : 0;
  const maxRate = rates.length > 0 ? Math.max(...rates) : 1;
  const ratePadding = (maxRate - minRate) * 0.1 || (minRate > 0 ? minRate * 0.05 : 0.01);
  const yMin = Math.max(0, minRate - ratePadding);
  const yMax = maxRate + ratePadding;
  const rateSpan = Math.max(yMax - yMin, 0.000001);

  function getX(time: number): number {
    return PADDING.left + ((time - minTime) / timeSpan) * CHART_WIDTH;
  }

  function getY(rate: number): number {
    return PADDING.top + (1 - (rate - yMin) / rateSpan) * CHART_HEIGHT;
  }

  // Segment creation respecting gaps
  const segments: Array<Array<{ x: number; y: number; originalIndex: number }>> = [];
  let currentSegment: Array<{ x: number; y: number; originalIndex: number }> = [];

  for (let i = 0; i < validPoints.length; i++) {
    const pt = validPoints[i]!;
    const prev = validPoints[i - 1];

    if (prev && pt.time - prev.time > GAP_THRESHOLD_MS) {
      if (currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
    }

    currentSegment.push({
      x: getX(pt.time),
      y: getY(pt.rate),
      originalIndex: pt.originalIndex,
    });
  }

  if (currentSegment.length > 0) {
    segments.push(currentSegment);
  }

  const activePoint =
    hoveredPointIndex !== null && history.points[hoveredPointIndex]
      ? history.points[hoveredPointIndex]
      : null;

  const yTicks = [
    { value: yMax, label: yMax.toFixed(4) },
    { value: (yMin + yMax) / 2, label: ((yMin + yMax) / 2).toFixed(4) },
    { value: yMin, label: yMin.toFixed(4) },
  ];

  const xTicks = [
    { time: minTime, label: new Date(minTime).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
    { time: minTime + timeSpan / 2, label: new Date(minTime + timeSpan / 2).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
    { time: maxTime, label: new Date(maxTime).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
  ];

  return (
    <section
      aria-labelledby="rate-history-heading"
      className="mt-10"
      data-testid="corridor-rate-history-section"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Rate timeline</p>
          <h2
            id="rate-history-heading"
            className="mt-2 text-2xl"
            style={{ fontFamily: "var(--display)" }}
          >
            Historical rate chart
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="sr-only">Select history window:</span>
          <div
            role="group"
            aria-label="Timeframe selection"
            className="inline-flex rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-1 text-xs"
          >
            {TIMEFRAME_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                onClick={() => handleTimeframeChange(option.days)}
                disabled={loading}
                aria-pressed={selectedDays === option.days}
                className={`rounded px-3 py-1 font-medium transition-colors ${
                  selectedDays === option.days
                    ? "bg-[var(--ghost)] text-[var(--white)]"
                    : "text-[var(--muted)] hover:text-[var(--white)]"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-lg border border-[var(--ghost)] bg-[var(--surface)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[var(--ghost)] text-xs text-[var(--muted)]">
          <div className="flex items-center gap-4">
            <span>
              <strong className="font-medium text-[var(--white)]">
                {history.points.length}
              </strong>{" "}
              {history.points.length === 1 ? "snapshot" : "snapshots"}
            </span>
            <span>
              <strong className="font-medium text-[var(--white)]">
                {validPoints.length}
              </strong>{" "}
              median {validPoints.length === 1 ? "point" : "points"}
            </span>
            <span className="rounded bg-[var(--ghost)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
              Gaps preserved honestly
            </span>
          </div>
          {loading ? (
            <span className="text-[var(--muted)]">Loading rates...</span>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            className="my-6 rounded border border-[rgba(238,143,129,0.35)] p-4 text-sm text-[#ee8f81]"
          >
            {error}
          </div>
        ) : validPoints.length === 0 ? (
          <div className="py-12 text-center text-sm text-[var(--muted)]">
            <p>No historical rate snapshots recorded for the {selectedDays}-day window.</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Rates are plotted only when independent anchors quote on this corridor.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <figure className="relative">
              <svg
                aria-label={`Historical rate chart for ${corridorSlug} over the past ${selectedDays} days`}
                role="img"
                viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
                className="w-full h-auto overflow-visible select-none"
              >
                <defs>
                  <linearGradient
                    id={`${chartId}-area-grad`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Horizontal Grid lines & Y Ticks */}
                {yTicks.map((tick, i) => {
                  const y = getY(tick.value);
                  return (
                    <g key={i}>
                      <line
                        x1={PADDING.left}
                        y1={y}
                        x2={SVG_WIDTH - PADDING.right}
                        y2={y}
                        stroke="var(--ghost)"
                        strokeDasharray="4,4"
                      />
                      <text
                        x={PADDING.left - 10}
                        y={y + 4}
                        textAnchor="end"
                        fill="var(--muted)"
                        fontSize="11"
                        fontFamily="var(--sans)"
                      >
                        {tick.label}
                      </text>
                    </g>
                  );
                })}

                {/* X Ticks & Vertical Guides */}
                {xTicks.map((tick, i) => {
                  const x = getX(tick.time);
                  return (
                    <g key={i}>
                      <line
                        x1={x}
                        y1={PADDING.top}
                        x2={x}
                        y2={SVG_HEIGHT - PADDING.bottom}
                        stroke="var(--ghost)"
                        strokeDasharray="2,4"
                      />
                      <text
                        x={x}
                        y={SVG_HEIGHT - PADDING.bottom + 20}
                        textAnchor="middle"
                        fill="var(--muted)"
                        fontSize="11"
                        fontFamily="var(--sans)"
                      >
                        {tick.label}
                      </text>
                    </g>
                  );
                })}

                {/* Line Segments & Area under line */}
                {segments.map((seg, segIdx) => {
                  if (seg.length === 0) return null;
                  const lineD = seg.reduce(
                    (acc, pt, idx) => `${acc} ${idx === 0 ? "M" : "L"} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`,
                    "",
                  );

                  const firstPt = seg[0]!;
                  const lastPt = seg[seg.length - 1]!;
                  const bottomY = PADDING.top + CHART_HEIGHT;
                  const areaD = `${lineD} L ${lastPt.x.toFixed(2)} ${bottomY} L ${firstPt.x.toFixed(2)} ${bottomY} Z`;

                  return (
                    <g key={segIdx}>
                      <path
                        d={areaD}
                        fill={`url(#${chartId}-area-grad)`}
                        pointerEvents="none"
                      />
                      <path
                        d={lineD}
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </g>
                  );
                })}

                {/* Point markers & hover target zones */}
                {validPoints.map((pt, idx) => {
                  const cx = getX(pt.time);
                  const cy = getY(pt.rate);
                  const isHovered = hoveredPointIndex === pt.originalIndex;

                  return (
                    <g key={idx}>
                      {/* Invisible larger target for easy hovering */}
                      <circle
                        cx={cx}
                        cy={cy}
                        r="12"
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoveredPointIndex(pt.originalIndex)}
                        onMouseLeave={() => setHoveredPointIndex(null)}
                        onFocus={() => setHoveredPointIndex(pt.originalIndex)}
                        onBlur={() => setHoveredPointIndex(null)}
                        tabIndex={0}
                        aria-label={`Snapshot on ${new Date(pt.time).toLocaleString()}: median rate ${pt.point.medianRate}`}
                      />
                      <circle
                        cx={cx}
                        cy={cy}
                        r={isHovered ? 6 : 3.5}
                        fill={isHovered ? "var(--white)" : "var(--accent)"}
                        stroke="var(--black)"
                        strokeWidth="2"
                        className="transition-all duration-150 pointer-events-none"
                      />
                    </g>
                  );
                })}
              </svg>
              <figcaption className="sr-only">
                Chart showing {validPoints.length} median rate snapshots for {corridorSlug} over {selectedDays} days.
              </figcaption>
            </figure>

            {/* Active inspection tooltip / card */}
            <div
              className={`mt-4 rounded-md border p-4 transition-colors ${
                activePoint
                  ? "border-[var(--accent)] bg-[var(--surface)]"
                  : "border-[var(--ghost)] bg-[rgba(255,255,255,0.02)]"
              }`}
            >
              {activePoint ? (
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--ghost)] pb-2 text-xs">
                    <span className="text-[var(--white)] font-medium">
                      {new Date(activePoint.timestamp).toLocaleString()}
                    </span>
                    <span
                      className="rounded px-2 py-0.5 text-[11px] uppercase tracking-wide"
                      style={{
                        backgroundColor:
                          activePoint.state === "healthy"
                            ? "rgba(21, 221, 128, 0.15)"
                            : "var(--ghost)",
                        color:
                          activePoint.state === "healthy"
                            ? "var(--accent)"
                            : "var(--muted)",
                      }}
                    >
                      {activePoint.state === "healthy" ? "Healthy Median" : "Insufficient Fresh Sources"}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Median Rate</p>
                      <p
                        className="text-lg font-medium text-[var(--white)]"
                        style={{ fontFamily: "var(--display)" }}
                      >
                        {activePoint.medianRate ?? "Unavailable"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Sources</p>
                      <p className="text-sm text-[var(--white)]">
                        {activePoint.freshSourceCount} fresh ({activePoint.sourceCount} total)
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Observations</p>
                      <p className="text-xs text-[var(--muted)]">
                        {activePoint.observations.map((o) => `${o.anchor.name} (${o.rate})`).join(", ")}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-[var(--muted)] text-center py-1">
                  Hover or focus on any rate point in the timeline to inspect detailed snapshot observations.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
