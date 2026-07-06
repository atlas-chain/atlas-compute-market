import { Link } from "react-router-dom";
import type { DemandSim, DemandSimRequestor } from "./api";
import { SimJobsTable } from "./SimJobsTable";
import { accruing, fmtGlm, fmtInt, timeAgo, untilShort } from "./format";

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
  const live = r.match ? accruing(r.match.pricePerHour, r.match.sinceIso) : 0;
  return (
    <tr>
      <td className="mono" title={r.requestorId}>
        <Link to={`/requestors/${r.requestorId}`}>{r.displayName}</Link>
      </td>
      <td className="muted">{r.shape}</td>
      <td className="muted">{wants(r)}</td>
      <td className="num">{r.maxPricePerHour}</td>
      <td>
        <span className={`pill ${PILL[r.status]}`}>{r.status}</span>
      </td>
      <td className="muted" title={r.match?.offerId}>
        {r.match ? (
          <>
            <Link to={`/providers/${r.match.providerId}`}>{r.match.providerName}</Link>
            {` @ ${r.match.pricePerHour} ${unit}/h · ${untilShort(r.match.untilIso)} left`}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="num" title={r.match ? `+${fmtGlm(live)} accruing on the current job` : undefined}>
        {fmtGlm(r.spent + live)}
      </td>
      <td className="num" title="completed jobs, all time (ledger-backed)">{fmtInt(r.jobs)}</td>
      <td className="num">{fmtInt(r.counters.noMatch)}</td>
      <td className="num">{fmtInt(r.counters.queries)}</td>
      <td className={r.counters.bugs > 0 ? "num error-note" : "num muted"}>{fmtInt(r.counters.bugs)}</td>
      <td className="muted">{timeAgo(r.updatedAt)}</td>
    </tr>
  );
}

export function DemandTable({ demand, unit }: { demand: DemandSim | null; unit: string }) {
  const items = demand?.requestors ?? [];
  const earnings = demand?.earnings ?? [];
  const liveSpend = items.reduce((s, r) => s + (r.match ? accruing(r.match.pricePerHour, r.match.sinceIso) : 0), 0);
  return (
    <section className="card">
      <div>
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
                <th className="num">spent {unit}</th>
                <th className="num">jobs</th>
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
                  <td colSpan={12} className="muted">
                    demand simulation is off (set ATLAS_DEV_REQUESTORS to enable — dev deployments only)
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="table-foot">
            <span className="hint">
              {items.length} simulated requestors · Σ spent {fmtGlm((demand?.totals.spent ?? 0) + liveSpend)} {unit}{" "}
              over {fmtInt(demand?.totals.jobs ?? 0)} completed jobs (simulated money, settled to a Postgres ledger —
              survives restarts) · they follow the spec §9 flow against the real API but only ever hire dev-dummy
              providers; real matching stays P2P and off-registry
            </span>
          </div>
        </div>
      </div>

      {earnings.length > 0 && (
        <div>
          <h2 className="label">[dummy provider earnings — dev only]</h2>
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>provider</th>
                  <th className="num">earned {unit}</th>
                  <th className="num">jobs</th>
                  <th>last job</th>
                </tr>
              </thead>
              <tbody>
                {earnings.map((e) => (
                  <tr key={e.providerId}>
                    <td className="mono" title={e.providerId}>
                      <Link to={`/providers/${e.providerId}`}>{e.displayName}</Link>
                    </td>
                    <td className="num">{fmtGlm(e.earned)}</td>
                    <td className="num">{fmtInt(e.jobs)}</td>
                    <td className="muted">{timeAgo(e.lastJobAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-foot">
              <span className="hint">
                mirror of requestor spending — every completed sim job credits its provider, so totals match by
                construction
              </span>
            </div>
          </div>
        </div>
      )}

      {demand && (
        <div>
          <h2 className="label">[job history — dev only]</h2>
          <SimJobsTable unit={unit} limit={20} />
        </div>
      )}
    </section>
  );
}
