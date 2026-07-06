import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ProviderItem } from "./api";
import { usePoll } from "./usePoll";
import { fmtInt, providerStatus, shortHex, timeAgo } from "./format";

const PAGE = 25;

function liveness(p: ProviderItem): { cls: string; text: string } {
  if (p.liveOffers > 0) return { cls: "on", text: `live · ${timeAgo(p.lastSeenAt)}` };
  if (p.lastSeenAt) return { cls: "warn", text: `stale · ${timeAgo(p.lastSeenAt)}` };
  return { cls: "", text: "never seen" };
}

export function ProvidersTable() {
  const [offset, setOffset] = useState(0);
  const { data, error } = usePoll(() => api.providers(PAGE, offset), 10_000, [offset]);
  const navigate = useNavigate();

  const total = data?.total ?? 0;
  return (
    <section>
      <h2 className="label">[providers]</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>provider</th>
              <th>address</th>
              <th>status</th>
              <th>cpu</th>
              <th className="num">cores</th>
              <th className="num">ram gib</th>
              <th className="num">score full</th>
              <th className="num">offers live/active</th>
              <th>last seen</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((p) => {
              const lv = liveness(p);
              const st = providerStatus(p.liveOffers, p.busyOffers, p.lastSeenAt);
              return (
                <tr key={p.providerId} className="rowlink" onClick={() => navigate(`/providers/${p.providerId}`)}>
                  <td>{p.displayName}</td>
                  <td className="mono muted" title={p.providerId}>
                    {shortHex(p.providerId, 10, 4)}
                  </td>
                  <td>
                    <span className={`pill ${st.cls}`} title={`${p.busyOffers}/${p.liveOffers} live offers busy`}>
                      {st.label}
                    </span>
                  </td>
                  <td className="muted">{p.attestation?.cpuModel ?? "—"}</td>
                  <td className="num">{p.attestation ? p.attestation.coreCount : "—"}</td>
                  <td className="num">{p.attestation ? p.attestation.ramGib : "—"}</td>
                  <td className="num">{p.attestation ? fmtInt(p.attestation.scores.full) : "—"}</td>
                  <td className="num">
                    {p.liveOffers}/{p.activeOffers}
                  </td>
                  <td>
                    <span className="livecell">
                      <span className={`dot ${lv.cls}`} />
                      {lv.text}
                    </span>
                  </td>
                </tr>
              );
            })}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  no providers registered yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="table-foot">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← prev
          </button>
          <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            next →
          </button>
          <span className="hint">
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`} · click a row for the
            provider card
          </span>
        </div>
        {error && <p className="error-note">providers unavailable: {error}</p>}
      </div>
    </section>
  );
}
