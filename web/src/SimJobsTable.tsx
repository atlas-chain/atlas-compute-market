import { Link } from "react-router-dom";
import { api } from "./api";
import { usePoll } from "./usePoll";
import { fmtGlm, shortHex, timeAgo } from "./format";

/**
 * Recent settled jobs from the durable sim ledger (GET /v1/sim/jobs).
 * `party` narrows to one requestor/provider (its own column is then omitted).
 * Render only on sim-enabled deployments (caller gates on stats.demandSim).
 */
export function SimJobsTable({
  unit,
  party,
  limit = 15,
}: {
  unit: string;
  party?: { requestor?: string; provider?: string };
  limit?: number;
}) {
  const { data, error } = usePoll(() => api.simJobs(limit, party), 10_000, [party?.requestor, party?.provider, limit]);
  const jobs = data?.jobs ?? [];
  return (
    <div className="panel">
      <h3 className="label">[recent simulated jobs — durable ledger]</h3>
      <table>
        <thead>
          <tr>
            <th>settled</th>
            {!party?.requestor && <th>requestor</th>}
            {!party?.provider && <th>provider</th>}
            <th>shape</th>
            <th className="num">price {unit}/h</th>
            <th className="num">ran</th>
            <th className="num">cost {unit}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className="muted">{timeAgo(j.settledAt)}</td>
              {!party?.requestor && (
                <td className="mono" title={j.requestorId}>
                  <Link to={`/requestors/${j.requestorId}`}>{j.requestorName}</Link>
                </td>
              )}
              {!party?.provider && (
                <td className="mono" title={j.providerId}>
                  <Link to={`/providers/${j.providerId}`}>{j.providerName}</Link>
                </td>
              )}
              <td className="muted">{j.shape}</td>
              <td className="num">{j.pricePerHour}</td>
              <td className="num">{Math.round(j.runMs / 1000)}s</td>
              <td className="num" title={`offer ${shortHex(j.offerId, 12, 4)}`}>
                {fmtGlm(j.cost)}
              </td>
            </tr>
          ))}
          {data && jobs.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                no settled jobs yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="table-foot">
        <span className="hint">
          {data ? `${jobs.length} of ${data.total} settled jobs` : "…"} · one row per completed sim job, persisted in
          Postgres — the raw data behind the spending/earnings aggregates
        </span>
      </div>
      {error && <p className="error-note">sim ledger unavailable: {error}</p>}
    </div>
  );
}
