import { Link, useParams } from "react-router-dom";
import type { DemandSim } from "./api";
import { accruing, fmtGlm, fmtInt, shortHex, timeAgo, untilShort } from "./format";

const PILL: Record<string, string> = { running: "active", probing: "stale", searching: "", idle: "" };

/** Full-page card for one simulated dev requestor: job shape, spending, current match. */
export function RequestorCard({ demand, unit }: { demand: DemandSim | null; unit: string }) {
  const { id = "" } = useParams();
  const r = demand?.requestors.find((x) => x.requestorId === id) ?? null;

  if (!demand || !r) {
    return (
      <section className="card">
        <Link className="back" to="/demand">← simulated demand</Link>
        <p className="hint">
          {demand
            ? `no simulated requestor ${shortHex(id, 10, 4)} — the sim resets when the service restarts`
            : "demand simulation is off (set ATLAS_DEV_REQUESTORS to enable — dev deployments only)"}
        </p>
      </section>
    );
  }

  const live = r.match ? accruing(r.match.pricePerHour, r.match.sinceIso) : 0;
  return (
    <section className="card">
      <Link className="back" to="/demand">← simulated demand</Link>
      <div className="card-head">
        <h2>{r.displayName}</h2>
        <span className={`pill ${PILL[r.status]}`}>{r.status}</span>
        <span className="addr mono">{r.requestorId}</span>
      </div>

      <div className="card-cols">
        <div className="panel">
          <h3 className="label">[job shape]</h3>
          <div className="detail-grid">
            <div>
              <span className="k">shape</span>
              <span className="v">{r.shape}</span>
            </div>
            <div>
              <span className="k">wants</span>
              <span className="v">
                {[
                  r.wants.coresMin && `≥${r.wants.coresMin} cores`,
                  r.wants.ramGibMin && `≥${r.wants.ramGibMin} GiB ram`,
                  r.wants.scoreFullMin && `score ≥${fmtInt(r.wants.scoreFullMin)}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "anything"}
              </span>
            </div>
            <div>
              <span className="k">price ceiling</span>
              <span className="v">{r.maxPricePerHour} {unit}/h</span>
            </div>
            <div>
              <span className="k">updated</span>
              <span className="v">{timeAgo(r.updatedAt)}</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h3 className="label">[spending — simulated {unit}]</h3>
          <div className="detail-grid">
            <div>
              <span className="k">spent (completed jobs)</span>
              <span className="v">{fmtGlm(r.spent)} {unit}</span>
            </div>
            <div>
              <span className="k">accruing now</span>
              <span className="v">{r.match ? `+${fmtGlm(live)} ${unit}` : "—"}</span>
            </div>
            <div>
              <span className="k">jobs completed</span>
              <span className="v">{fmtInt(r.counters.matches - (r.match ? 1 : 0))}</span>
            </div>
            <div>
              <span className="k">avg per job</span>
              <span className="v">
                {r.counters.matches - (r.match ? 1 : 0) > 0
                  ? `${fmtGlm(r.spent / (r.counters.matches - (r.match ? 1 : 0)))} ${unit}`
                  : "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3 className="label">[current job]</h3>
        {r.match ? (
          <div className="detail-grid">
            <div>
              <span className="k">provider</span>
              <span className="v">
                <Link to={`/providers/${r.match.providerId}`}>{r.match.providerName}</Link>
              </span>
            </div>
            <div>
              <span className="k">offer</span>
              <span className="v mono" title={r.match.offerId}>{shortHex(r.match.offerId, 14, 6)}</span>
            </div>
            <div>
              <span className="k">price</span>
              <span className="v">{r.match.pricePerHour} {unit}/h</span>
            </div>
            <div>
              <span className="k">started</span>
              <span className="v">{timeAgo(r.match.sinceIso)}</span>
            </div>
            <div>
              <span className="k">ends in</span>
              <span className="v">{untilShort(r.match.untilIso)}</span>
            </div>
          </div>
        ) : (
          <p className="hint">no job running — {r.status === "searching" ? "searching the market" : r.status}</p>
        )}
      </div>

      <div className="panel">
        <h3 className="label">[counters — since service start]</h3>
        <div className="detail-grid">
          <div>
            <span className="k">queries</span>
            <span className="v">{fmtInt(r.counters.queries)}</span>
          </div>
          <div>
            <span className="k">matches</span>
            <span className="v">{fmtInt(r.counters.matches)}</span>
          </div>
          <div>
            <span className="k">no match</span>
            <span className="v">{fmtInt(r.counters.noMatch)}</span>
          </div>
          <div>
            <span className="k">probe rejected</span>
            <span className="v">{fmtInt(r.counters.probeRejected)}</span>
          </div>
          <div>
            <span className="k">bugs observed</span>
            <span className={r.counters.bugs > 0 ? "v error-note" : "v"}>{fmtInt(r.counters.bugs)}</span>
          </div>
        </div>
        <p className="hint">
          a simulated requestor runs the spec §9 flow against the real API — query, verify signatures, probe — and only
          ever hires dev-dummy providers; its spending is simulated {unit}, settled per completed job
        </p>
      </div>
    </section>
  );
}
