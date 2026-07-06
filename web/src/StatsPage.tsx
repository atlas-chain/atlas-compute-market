import { useState } from "react";
import { api, type HistoryPoint, type HistoryRange } from "./api";
import { usePoll } from "./usePoll";
import { LineChart, type ChartSeries } from "./LineChart";
import { fmtGlm } from "./format";

const RANGES: HistoryRange[] = ["1h", "6h", "24h", "7d", "30d"];

// palette (matches index.css custom properties)
const BLUE = "#181ea9";
const ORANGE = "#fe7446";
const GREEN = "#1f7a4d";
const AMBER = "#b25e09";
const INK = "#111111";

type Pick = (p: HistoryPoint) => number | null;
const pick = (points: HistoryPoint[], f: Pick): Array<[number, number | null]> =>
  points.map((p) => [p.at, f(p)]);

/** Per-hour settle rate from the cumulative sim ledger counters. */
function ratePerHour(points: HistoryPoint[], stepSec: number, f: Pick): Array<[number, number | null]> {
  const out: Array<[number, number | null]> = [];
  for (let i = 1; i < points.length; i++) {
    const a = f(points[i - 1]!);
    const b = f(points[i]!);
    // cumulative counters only grow; a drop means the ledger was truncated — mask it
    out.push([points[i]!.at, a === null || b === null || b < a ? null : ((b - a) * 3600) / stepSec]);
  }
  return out;
}

function Panel({ title, series, fmt }: { title: string; series: ChartSeries[]; fmt?: (v: number) => string }) {
  return (
    <div className="panel">
      <h3 className="label">[{title}]</h3>
      <LineChart series={series} fmt={fmt} />
    </div>
  );
}

export function StatsPage({ unit }: { unit: string }) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const { data, error } = usePoll(() => api.statsHistory(range), 30_000, [range]);

  const pts = data?.points ?? [];
  const step = data?.stepSec ?? 60;
  const hasSim = pts.some((p) => p.sim !== null);
  const fmtInt = (v: number) => Math.round(v).toLocaleString("en-US");

  return (
    <section className="card">
      <div className="card-head">
        <h2>network statistics</h2>
        <span className="range-picker">
          {RANGES.map((r) => (
            <button key={r} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </span>
        <span className="hint">
          durable time-series — sampled every minute into Postgres, bucket-averaged per range
        </span>
      </div>
      {error && <p className="error-note">history unavailable: {error}</p>}

      <div className="charts-grid">
        <Panel
          title="providers online"
          fmt={fmtInt}
          series={[
            { label: "live", color: GREEN, area: true, points: pick(pts, (p) => p.providers.active) },
            { label: "busy", color: BLUE, points: pick(pts, (p) => p.providers.busy) },
          ]}
        />
        <Panel
          title="offers"
          fmt={fmtInt}
          series={[
            { label: "live", color: GREEN, area: true, points: pick(pts, (p) => p.offers.live) },
            { label: "busy", color: BLUE, points: pick(pts, (p) => p.offers.busy) },
          ]}
        />
        <Panel
          title="live cores"
          fmt={fmtInt}
          series={[{ label: "cores", color: BLUE, area: true, points: pick(pts, (p) => p.capacity.liveCores) }]}
        />
        <Panel
          title="live ram"
          fmt={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)} TiB` : `${fmtInt(v)} GiB`)}
          series={[{ label: "ram", color: BLUE, area: true, points: pick(pts, (p) => p.capacity.liveRamGib) }]}
        />
        <Panel
          title={`price ${unit}/h (live offers)`}
          fmt={(v) => v.toFixed(3)}
          series={[
            { label: "median", color: INK, area: true, points: pick(pts, (p) => p.price?.median ?? null) },
            { label: "min", color: GREEN, points: pick(pts, (p) => p.price?.min ?? null) },
            { label: "max", color: ORANGE, points: pick(pts, (p) => p.price?.max ?? null) },
          ]}
        />
        <Panel
          title="valid attestations"
          fmt={fmtInt}
          series={[{ label: "attestations", color: AMBER, area: true, points: pick(pts, (p) => p.attestations.valid) }]}
        />
        {hasSim && (
          <>
            <Panel
              title={`sim volume — cumulative ${unit} settled (dev only)`}
              fmt={fmtGlm}
              series={[{ label: `spent = earned`, color: ORANGE, area: true, points: pick(pts, (p) => p.sim?.spent ?? null) }]}
            />
            <Panel
              title="sim jobs settled per hour (dev only)"
              fmt={(v) => v.toFixed(1)}
              series={[{ label: "jobs/h", color: ORANGE, area: true, points: ratePerHour(pts, step, (p) => p.sim?.jobs ?? null) }]}
            />
          </>
        )}
      </div>
      <p className="hint">
        all values are the unsigned market aggregates of GET /v1/stats, recorded once per minute
        (market_snapshots) and served bucket-averaged by GET /v1/stats/history — the same numbers,
        with memory
      </p>
    </section>
  );
}
