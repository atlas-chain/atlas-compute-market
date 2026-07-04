import { api } from "./api";
import { usePoll } from "./usePoll";
import { shortHex } from "./format";
import { Tiles } from "./Tiles";
import { ProvidersTable } from "./ProvidersTable";
import { OffersTable } from "./OffersTable";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";

export default function App() {
  const { data: spec } = usePoll(() => api.spec(), 300_000);
  const { data: health, error: healthError } = usePoll(() => api.health(), 10_000);
  const { data: stats, error: statsError } = usePoll(() => api.stats(), 5_000);

  const up = health !== null && !healthError && health.postgres === "ok";
  return (
    <>
      <header id="topbar">
        <span className="wordmark">
          <span className="bracket">[</span>
          <h1>Atlas</h1>
          <span className="bracket">]</span>
          <span>Compute Market</span>
        </span>
        <nav className="primary-nav" aria-label="Market sections">
          <NavLink to="/providers">Providers</NavLink>
          <NavLink to="/offers">Offers</NavLink>
        </nav>
        {spec && <span className="chip">spec {spec.version}</span>}
        {spec && <span className="chip">{spec.models.join(" · ")}</span>}
        {spec && <span className="chip">unit {spec.unit}</span>}
        {spec && (
          <span className="chip" title={spec.serviceKey}>
            attester {shortHex(spec.serviceKey, 8, 4)}
          </span>
        )}
        <span className="head-right">
          <span className="conn">
            <span className={`conn-dot ${up ? "on" : ""}`} />
            {up ? (health?.redis === "ok" ? "registry up" : "up · liveness degraded") : "unreachable"}
          </span>
        </span>
      </header>

      <main>
        {statsError && !stats && <p className="error-note">registry unreachable: {statsError}</p>}
        <Tiles stats={stats} />
        <Routes>
          <Route path="/providers" element={<ProvidersTable />} />
          <Route path="/offers" element={<OffersTable unit={spec?.unit ?? "GLM"} />} />
          <Route path="*" element={<Navigate to="/providers" replace />} />
        </Routes>
      </main>

      <footer>
        read-only market view · data refreshes by polling · offers and profiles are provider-signed, attestations
        service-signed — verify envelopes client-side before transacting (spec §8.4)
      </footer>
    </>
  );
}
