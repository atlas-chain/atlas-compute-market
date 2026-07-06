import type { Stats } from "./api";
import { fmtGib, fmtInt, fmtPrice } from "./format";

export function Tiles({ stats }: { stats: Stats | null }) {
  const t = (v: string | number | null | undefined) => (v === null || v === undefined ? "—" : v);
  return (
    <section>
      <h2 className="label">[market at a glance]</h2>
      <div className="tiles">
        <div className="tile">
          <span className="k">providers</span>
          <span className="v">{t(stats && fmtInt(stats.providers.total))}</span>
        </div>
        <div className="tile good">
          <span className="k">providers live</span>
          <span className="v">{t(stats && fmtInt(stats.providers.active))}</span>
        </div>
        <div className="tile">
          <span className="k">offers active</span>
          <span className="v">{t(stats && fmtInt(stats.offers.active))}</span>
        </div>
        <div className="tile good">
          <span className="k">offers live</span>
          <span className="v">{t(stats && fmtInt(stats.offers.live))}</span>
        </div>
        {stats?.offers.busy !== undefined && stats.offers.busy > 0 && (
          <div className="tile">
            <span className="k">offers busy</span>
            <span className="v">{fmtInt(stats.offers.busy)}</span>
          </div>
        )}
        <div className="tile accent">
          <span className="k">live cores</span>
          <span className="v">{t(stats && fmtInt(stats.capacity.liveCores))}</span>
        </div>
        <div className="tile accent">
          <span className="k">live ram</span>
          <span className="v">{t(stats && fmtGib(stats.capacity.liveRamGib))}</span>
        </div>
        <div className="tile">
          <span className="k">median price</span>
          <span className="v">
            {t(stats && fmtPrice(stats.price?.median))}
            <span className="u">{stats?.unit ?? "GLM"}/h</span>
          </span>
        </div>
        <div className="tile">
          <span className="k">price range</span>
          <span className="v">
            {stats?.price ? `${fmtPrice(stats.price.min)}–${fmtPrice(stats.price.max)}` : "—"}
          </span>
        </div>
      </div>
    </section>
  );
}
