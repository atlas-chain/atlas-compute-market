import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type OfferFilters, type OfferItem, type OfferList } from "./api";
import { fmtInt, shortHex, untilShort } from "./format";

const PAGE = 25;

// availability defaults to "any" here so the dashboard *shows* busy offers
// (marked), rather than hiding them as a rent-focused client would (§6.5).
const DEFAULT_FILTERS: OfferFilters = { freshness: "normal", availability: "any", sort: "price" };

function OfferRow({ o }: { o: OfferItem }) {
  const att = o.attestation.envelope.payload;
  const terms = o.terms?.envelope.payload ?? null;
  return (
    <tr>
      <td className="mono muted" title={o.offerId}>
        {shortHex(o.offerId, 12, 4)}
      </td>
      <td className="mono" title={o.template.envelope.payload.providerId}>
        <Link to={`/providers/${o.template.envelope.payload.providerId}`}>
          {shortHex(o.template.envelope.payload.providerId, 10, 4)}
        </Link>
      </td>
      <td className="muted">{att.cpuModel ?? "—"}</td>
      <td className="num">{att.coreCount}</td>
      <td className="num">{att.ramGib}</td>
      <td className="num">{fmtInt(att.scores.full)}</td>
      <td className="num">{terms ? `${terms.minPricePerHour}` : "—"}</td>
      <td className="num">{terms?.capacity?.coresFree ?? "—"}</td>
      <td>
        <span className={`pill ${o.status}`}>{o.status}</span>
      </td>
      <td className="muted">{untilShort(o.template.envelope.payload.expiresAt)}</td>
    </tr>
  );
}

export function OffersTable({ unit }: { unit: string }) {
  const [filters, setFilters] = useState<OfferFilters>(DEFAULT_FILTERS);
  const [pages, setPages] = useState<OfferItem[][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  // first page: (re)loaded on filter change and refreshed on a slow poll;
  // "load more" appends via the cursor and is left alone by the poll.
  const loadFirst = useCallback(async (f: OfferFilters) => {
    const gen = ++generation.current;
    try {
      const r: OfferList = await api.offers(f, PAGE);
      if (gen !== generation.current) return;
      setPages((prev) => (prev.length > 1 ? [r.items, ...prev.slice(1)] : [r.items]));
      setCursor((prev) => (generation.current === gen && prev === null ? r.nextCursor : prev ?? r.nextCursor));
      setError(null);
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setPages([]);
    setCursor(null);
    loadFirst(filters);
    const t = setInterval(() => {
      // don't fight pagination: only auto-refresh while showing page one
      if (generation.current >= 0) loadFirst(filters);
    }, 15_000);
    return () => clearInterval(t);
  }, [filters, loadFirst]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await api.offers(filters, PAGE, cursor);
      setPages((prev) => [...prev, r.items]);
      setCursor(r.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const set = (k: keyof OfferFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilters((f) => ({ ...f, [k]: e.target.value }));

  const items = pages.flat();
  return (
    <section>
      <h2 className="label">[offers]</h2>
      <div className="panel">
        <div className="filters">
          <label className="f">
            <span>cores ≥</span>
            <input inputMode="numeric" placeholder="any" value={filters["cores.min"] ?? ""} onChange={set("cores.min")} />
          </label>
          <label className="f">
            <span>ram gib ≥</span>
            <input inputMode="numeric" placeholder="any" value={filters["ram.gib.min"] ?? ""} onChange={set("ram.gib.min")} />
          </label>
          <label className="f">
            <span>score full ≥</span>
            <input inputMode="numeric" placeholder="any" value={filters["score.full.min"] ?? ""} onChange={set("score.full.min")} />
          </label>
          <label className="f">
            <span>price/h ≤ ({unit})</span>
            <input inputMode="decimal" placeholder="any" value={filters["price.perHour.max"] ?? ""} onChange={set("price.perHour.max")} />
          </label>
          <label className="f">
            <span>freshness</span>
            <select value={filters.freshness} onChange={set("freshness")}>
              <option value="strict">strict</option>
              <option value="normal">normal</option>
              <option value="any">any (incl. stale)</option>
            </select>
          </label>
          <label className="f">
            <span>availability</span>
            <select value={filters.availability} onChange={set("availability")}>
              <option value="any">any (incl. busy)</option>
              <option value="free">free only</option>
            </select>
          </label>
          <label className="f">
            <span>sort</span>
            <select value={filters.sort} onChange={set("sort")}>
              <option value="price">price ↑</option>
              <option value="score.full">score full ↓</option>
              <option value="score.single">score single ↓</option>
              <option value="random">random</option>
            </select>
          </label>
          <button onClick={() => setFilters(DEFAULT_FILTERS)}>reset</button>
        </div>

        <table>
          <thead>
            <tr>
              <th>offer</th>
              <th>provider</th>
              <th>cpu</th>
              <th className="num">cores</th>
              <th className="num">ram gib</th>
              <th className="num">score full</th>
              <th className="num">price {unit}/h</th>
              <th className="num">cores free</th>
              <th>status</th>
              <th>expires</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <OfferRow key={o.offerId} o={o} />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={10} className="muted">
                  no offers match the current filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="table-foot">
          <button disabled={!cursor || loading} onClick={loadMore}>
            {loading ? "loading…" : cursor ? "load more" : "all loaded"}
          </button>
          <span className="hint">{items.length} shown · prices are each offer's current signed DynamicTerms</span>
        </div>
        {error && <p className="error-note">offers unavailable: {error}</p>}
      </div>
    </section>
  );
}
