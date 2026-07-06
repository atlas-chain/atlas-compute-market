import type { DemandSim, DemandSimRequestor } from "./api";
import { fmtInt, timeAgo, untilShort } from "./format";

// simulated statuses mapped onto the existing pill palette
const PILL: Record<DemandSimRequestor["status"], string> = {
  running: "active",
  probing: "stale",
  searching: "",
  idle: "",
};

function wants(r: DemandSimRequestor): string {
  const parts: string[] = [];
  if (r.wants.coresMin) parts.push(`≥${r.wants.coresMin}c`);
  if (r.wants.ramGibMin) parts.push(`≥${r.wants.ramGibMin} GiB`);
  if (r.wants.scoreFullMin) parts.push(`score ≥${fmtInt(r.wants.scoreFullMin)}`);
  return parts.length ? parts.join(" · ") : "anything";
}

function DemandRow({ r, unit }: { r: DemandSimRequestor; unit: string }) {
  return (
    <tr>
      <td className="mono" title={r.requestorId}>
        {r.displayName}
      </td>
      <td className="muted">{r.shape}</td>
      <td className="muted">{wants(r)}</td>
      <td className="num">{r.maxPricePerHour}</td>
      <td>
        <span className={`pill ${PILL[r.status]}`}>{r.status}</span>
      </td>
      <td className="muted" title={r.match?.offerId}>
        {r.match ? `${r.match.providerName} @ ${r.match.pricePerHour} ${unit}/h · ${untilShort(r.match.untilIso)} left` : "—"}
      </td>
      <td className="num">{fmtInt(r.counters.matches)}</td>
      <td className="num">{fmtInt(r.counters.noMatch)}</td>
      <td className="num">{fmtInt(r.counters.queries)}</td>
      <td className={r.counters.bugs > 0 ? "num error-note" : "num muted"}>{fmtInt(r.counters.bugs)}</td>
      <td className="muted">{timeAgo(r.updatedAt)}</td>
    </tr>
  );
}

export function DemandTable({ demand, unit }: { demand: DemandSim | null; unit: string }) {
  const items = demand?.requestors ?? [];
  return (
    <section>
      <h2 className="label">[simulated demand — dev only]</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>requestor</th>
              <th>job shape</th>
              <th>wants</th>
              <th className="num">max {unit}/h</th>
              <th>status</th>
              <th>matched provider</th>
              <th className="num">matches</th>
              <th className="num">no match</th>
              <th className="num">queries</th>
              <th className="num">bugs</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <DemandRow key={r.requestorId} r={r} unit={unit} />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={11} className="muted">
                  demand simulation is off (set ATLAS_DEV_REQUESTORS to enable — dev deployments only)
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="table-foot">
          <span className="hint">
            {items.length} simulated requestors · they follow the spec §9 flow against the real API (query → verify
            signatures → probe) but only ever hire dev-dummy providers; real matching stays P2P and off-registry
          </span>
        </div>
      </div>
    </section>
  );
}
