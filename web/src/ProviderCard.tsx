import { Link, useParams } from "react-router-dom";
import { api, type Stats } from "./api";
import { usePoll } from "./usePoll";
import { accruing, fmtGlm, fmtInt, providerStatus, shortHex, timeAgo, untilShort } from "./format";

/** Full-page card for one provider: profile, attestation, offers, sim earnings. */
export function ProviderCard({ stats, unit }: { stats: Stats | null; unit: string }) {
  const { id = "" } = useParams();
  const { data, error } = usePoll(() => api.provider(id), 10_000, [id]);

  const profile = data?.envelope.payload;
  const att = data?.attestation ?? null;
  const st = data ? providerStatus(data.stats.liveOffers, data.stats.busyOffers, data.stats.lastSeenAt) : null;

  // dev-sim view of this provider: accumulated earnings + who is renting it right now
  const earnings = stats?.demandSim?.earnings.find((e) => e.providerId === id) ?? null;
  const hirers = stats?.demandSim?.requestors.filter((r) => r.match?.providerId === id) ?? [];
  const accruingNow = hirers.reduce((s, r) => s + accruing(r.match!.pricePerHour, r.match!.sinceIso), 0);

  if (error) {
    return (
      <section className="card">
        <Link className="back" to="/providers">← all providers</Link>
        <p className="error-note">provider unavailable: {error}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <Link className="back" to="/providers">← all providers</Link>
      <div className="card-head">
        <h2>{(profile?.displayName as string) ?? shortHex(id, 10, 4)}</h2>
        {st && <span className={`pill ${st.cls}`}>{st.label}</span>}
        <span className="addr mono">{id}</span>
      </div>

      <div className="card-cols">
        <div className="panel">
          <h3 className="label">[profile — provider-signed]</h3>
          <div className="detail-grid">
            <div>
              <span className="k">net endpoints</span>
              <span className="v">{profile ? ((profile.netEndpoints as string[]) ?? []).join(", ") || "—" : "…"}</span>
            </div>
            <div>
              <span className="k">contact</span>
              <span className="v">{profile ? ((profile.contact as string) ?? "—") : "…"}</span>
            </div>
            <div>
              <span className="k">heartbeat interval</span>
              <span className="v">{profile ? `${profile.heartbeatIntervalSec as number}s` : "…"}</span>
            </div>
            <div>
              <span className="k">first seen</span>
              <span className="v">{data ? data.stats.firstSeenAt.slice(0, 19).replace("T", " ") + " UTC" : "…"}</span>
            </div>
            <div>
              <span className="k">last seen</span>
              <span className="v">{data ? timeAgo(data.stats.lastSeenAt) : "…"}</span>
            </div>
            <div>
              <span className="k">offers live / busy / active</span>
              <span className="v">
                {data ? `${data.stats.liveOffers} / ${data.stats.busyOffers} / ${data.stats.activeOffers}` : "…"}
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h3 className="label">[attestation — service-signed benchmark]</h3>
          {att ? (
            <div className="detail-grid">
              <div>
                <span className="k">cpu</span>
                <span className="v">{att.cpuModel ?? "—"}</span>
              </div>
              <div>
                <span className="k">cores / ram</span>
                <span className="v">{att.coreCount} / {att.ramGib} GiB</span>
              </div>
              <div>
                <span className="k">scores (single / quad / eight / full)</span>
                <span className="v">
                  {fmtInt(att.scores.singleCore)} / {fmtInt(att.scores.quadCore)} /{" "}
                  {fmtInt(att.scores.eightCore)} / {fmtInt(att.scores.full)}
                </span>
              </div>
              <div>
                <span className="k">expires</span>
                <span className="v">{untilShort(att.expiresAt)} ({att.expiresAt.slice(0, 10)})</span>
              </div>
              <div>
                <span className="k">attestation id</span>
                <span className="v">{shortHex(att.id, 18, 6)}</span>
              </div>
            </div>
          ) : (
            <p className="hint">{data ? "no valid attestation — this provider cannot advertise offers" : "…"}</p>
          )}
        </div>
      </div>

      <div className="panel">
        <h3 className="label">[offers]</h3>
        <table>
          <thead>
            <tr>
              <th>offer</th>
              <th className="num">price {unit}/h</th>
              <th className="num">cores free</th>
              <th>status</th>
              <th>expires</th>
            </tr>
          </thead>
          <tbody>
            {(data?.offers ?? []).map((o) => (
              <tr key={o.offerId}>
                <td className="mono muted" title={o.offerId}>{shortHex(o.offerId, 12, 4)}</td>
                <td className="num">{o.minPricePerHour ?? "—"}</td>
                <td className="num">{o.coresFree ?? "—"}</td>
                <td><span className={`pill ${o.status}`}>{o.status}</span></td>
                <td className="muted">{untilShort(o.expiresAt)}</td>
              </tr>
            ))}
            {data && data.offers.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">no active offers</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {stats?.demandSim && (earnings || hirers.length > 0) && (
        <div className="panel">
          <h3 className="label">[simulated earnings — dev only]</h3>
          <div className="detail-grid">
            <div>
              <span className="k">earned (completed jobs)</span>
              <span className="v">{fmtGlm(earnings?.earned ?? 0)} {unit}</span>
            </div>
            <div>
              <span className="k">jobs completed</span>
              <span className="v">{fmtInt(earnings?.jobs ?? 0)}</span>
            </div>
            <div>
              <span className="k">last job</span>
              <span className="v">{earnings ? timeAgo(earnings.lastJobAt) : "—"}</span>
            </div>
            <div>
              <span className="k">accruing now</span>
              <span className="v">{hirers.length > 0 ? `+${fmtGlm(accruingNow)} ${unit}` : "—"}</span>
            </div>
            <div>
              <span className="k">currently hired by</span>
              <span className="v">
                {hirers.length > 0
                  ? hirers.map((r, i) => (
                      <span key={r.requestorId}>
                        {i > 0 && ", "}
                        <Link to={`/requestors/${r.requestorId}`}>{r.displayName}</Link>
                        {" @ "}{r.match!.pricePerHour} {unit}/h
                      </span>
                    ))
                  : "nobody"}
              </span>
            </div>
          </div>
          <p className="hint">
            simulated money: dev requestors paying dev dummies — resets with the service, never real {unit}
          </p>
        </div>
      )}
    </section>
  );
}
