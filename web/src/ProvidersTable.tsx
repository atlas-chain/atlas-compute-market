import { Fragment, useState } from "react";
import { api, type ProviderDetail, type ProviderItem } from "./api";
import { usePoll } from "./usePoll";
import { fmtInt, shortHex, timeAgo, untilShort } from "./format";

const PAGE = 25;

function liveness(p: ProviderItem): { cls: string; text: string } {
  if (p.liveOffers > 0) return { cls: "on", text: `live · ${timeAgo(p.lastSeenAt)}` };
  if (p.lastSeenAt) return { cls: "warn", text: `stale · ${timeAgo(p.lastSeenAt)}` };
  return { cls: "", text: "never seen" };
}

function DetailRow({ p, detail, error }: { p: ProviderItem; detail: ProviderDetail | null; error: string | null }) {
  const profile = detail?.envelope.payload;
  return (
    <tr className="detail">
      <td colSpan={8}>
        {error && <p className="error-note">failed to load profile: {error}</p>}
        <div className="detail-grid">
          <div>
            <span className="k">provider id</span>
            <span className="v">{p.providerId}</span>
          </div>
          <div>
            <span className="k">net endpoints</span>
            <span className="v">
              {profile ? ((profile.netEndpoints as string[]) ?? []).join(", ") || "—" : "…"}
            </span>
          </div>
          <div>
            <span className="k">contact</span>
            <span className="v">{profile ? ((profile.contact as string) ?? "—") : "…"}</span>
          </div>
          <div>
            <span className="k">heartbeat interval</span>
            <span className="v">{p.heartbeatIntervalSec}s</span>
          </div>
          {p.attestation && (
            <>
              <div>
                <span className="k">scores (single / quad / eight / full)</span>
                <span className="v">
                  {fmtInt(p.attestation.scores.singleCore)} / {fmtInt(p.attestation.scores.quadCore)} /{" "}
                  {fmtInt(p.attestation.scores.eightCore)} / {fmtInt(p.attestation.scores.full)}
                </span>
              </div>
              <div>
                <span className="k">attestation expires</span>
                <span className="v">
                  {untilShort(p.attestation.expiresAt)} ({p.attestation.expiresAt.slice(0, 10)})
                </span>
              </div>
            </>
          )}
          <div>
            <span className="k">first seen</span>
            <span className="v">{p.firstSeenAt.slice(0, 19).replace("T", " ")} UTC</span>
          </div>
          {detail?.attestation && (
            <div>
              <span className="k">attestation id</span>
              <span className="v">{shortHex(detail.attestation.id, 18, 6)}</span>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

export function ProvidersTable() {
  const [offset, setOffset] = useState(0);
  const { data, error } = usePoll(() => api.providers(PAGE, offset), 10_000, [offset]);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ProviderDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);

  const toggle = (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setDetailError(null);
    if (!details[id]) {
      api
        .provider(id)
        .then((d) => setDetails((m) => ({ ...m, [id]: d })))
        .catch((e) => setDetailError((e as Error).message));
    }
  };

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
              return (
                <Fragment key={p.providerId}>
                  <tr className="rowlink" onClick={() => toggle(p.providerId)}>
                    <td>{p.displayName}</td>
                    <td className="mono muted" title={p.providerId}>
                      {shortHex(p.providerId, 10, 4)}
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
                  {open === p.providerId && (
                    <DetailRow p={p} detail={details[p.providerId] ?? null} error={detailError} />
                  )}
                </Fragment>
              );
            })}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
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
            {total === 0 ? "0" : `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`} · click a row for
            details
          </span>
        </div>
        {error && <p className="error-note">providers unavailable: {error}</p>}
      </div>
    </section>
  );
}
