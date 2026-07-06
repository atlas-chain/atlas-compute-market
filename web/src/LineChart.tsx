import { useRef, useState } from "react";

export interface ChartSeries {
  label: string;
  color: string;
  /** [unix seconds, value|null] — null breaks the line. */
  points: Array<[number, number | null]>;
  /** Fill the area under this series (usually only the first). */
  area?: boolean;
}

const W = 640;
const H = 170;
const PAD = 6;

function fmtTime(atSec: number, spanSec: number): string {
  const d = new Date(atSec * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (spanSec <= 86_400) return hm;
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${hm}`;
}

/**
 * Minimal dependency-free SVG line chart in the page's design language:
 * hairlines, mono labels, hover crosshair. Series share one x/y scale.
 */
export function LineChart({
  series,
  fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 }),
}: {
  series: ChartSeries[];
  fmt?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null); // index into points
  const svgRef = useRef<SVGSVGElement>(null);

  const xs = series[0]?.points.map(([at]) => at) ?? [];
  const n = xs.length;
  if (n < 2) {
    return <p className="hint">not enough history yet — the sampler records one point per minute</p>;
  }
  const x0 = xs[0]!;
  const x1 = xs[n - 1]!;
  const span = x1 - x0;

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series)
    for (const [, v] of s.points)
      if (v !== null) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
  if (!Number.isFinite(lo)) return <p className="hint">no data in this range</p>;
  if (hi === lo) {
    hi += 1;
    lo = Math.max(0, lo - 1);
  }
  const padY = (hi - lo) * 0.08;
  const yLo = Math.max(0, lo - padY);
  const yHi = hi + padY;

  const X = (at: number) => PAD + ((at - x0) / span) * (W - 2 * PAD);
  const Y = (v: number) => H - PAD - ((v - yLo) / (yHi - yLo)) * (H - 2 * PAD);

  const path = (pts: Array<[number, number | null]>): string => {
    let d = "";
    let pen = false;
    for (const [at, v] of pts) {
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${X(at).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(frac * (n - 1)));
  };

  const hv = hover !== null ? hover : n - 1; // legend shows hovered, else latest
  return (
    <div className="chart">
      <div className="chart-legend">
        {series.map((s) => {
          const v = s.points[hv]?.[1];
          return (
            <span key={s.label} className="chart-key">
              <span className="swatch" style={{ background: s.color }} />
              {s.label} <b>{v === null || v === undefined ? "—" : fmt(v)}</b>
            </span>
          );
        })}
        <span className="chart-when">{fmtTime(xs[hv]!, span)} UTC</span>
      </div>
      <div className="chart-body">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="gridline" />
          ))}
          {series.map(
            (s) =>
              s.area && (
                <path
                  key={`a-${s.label}`}
                  d={`${path(s.points)}L${X(x1).toFixed(1)},${H - PAD}L${X(x0).toFixed(1)},${H - PAD}Z`}
                  fill={s.color}
                  opacity={0.08}
                  stroke="none"
                />
              ),
          )}
          {series.map((s) => (
            <path key={s.label} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
          ))}
          {hover !== null && (
            <>
              <line x1={X(xs[hover]!)} x2={X(xs[hover]!)} y1={0} y2={H} className="crosshair" />
              {series.map((s) => {
                const v = s.points[hover]?.[1];
                return v === null || v === undefined ? null : (
                  <circle key={`c-${s.label}`} cx={X(xs[hover]!)} cy={Y(v)} r={3} fill={s.color} />
                );
              })}
            </>
          )}
        </svg>
        <span className="chart-y-max">{fmt(yHi)}</span>
        <span className="chart-y-min">{fmt(yLo)}</span>
      </div>
      <div className="chart-x">
        <span>{fmtTime(x0, span)}</span>
        <span>{fmtTime(x1, span)} UTC</span>
      </div>
    </div>
  );
}
