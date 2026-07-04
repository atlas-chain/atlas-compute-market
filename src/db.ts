/**
 * PostgreSQL — the only durable store (§2, §14).
 * Schema per spec §14, minus the deferred epochs table; payload_log.epoch
 * is nullable and unused until §11 ships. Attestations are appended to
 * payload_log like every other durable object (hash = attestation_id).
 */
import { SQL } from "bun";
import { config } from "./config.ts";

export const sql = new SQL(config.databaseUrl);

export async function migrate(): Promise<void> {
  await sql`
    create table if not exists payload_log (
      hash        bytea primary key,
      type        text not null,
      provider_id bytea not null,
      payload     jsonb not null,
      signature   bytea not null,
      received_at timestamptz not null default now(),
      epoch       bigint
    )`;
  await sql`
    create table if not exists providers (
      provider_id  bytea primary key,
      profile_hash bytea not null references payload_log(hash),
      signed_at    timestamptz not null,
      heartbeat_interval_sec int not null,
      first_seen_at timestamptz not null,
      updated_at    timestamptz not null
    )`;
  await sql`
    create table if not exists attestations (
      attestation_id bytea primary key,
      provider_id    bytea not null references providers(provider_id),
      model          text not null,
      arch           text not null,
      core_count     int  not null,
      ram_gib        numeric not null,
      cpu_model      text,
      score_single   bigint not null,
      score_quad     bigint not null,
      score_eight    bigint not null,
      score_full     bigint not null,
      score_ram_bandwidth bigint,
      score_dag_hash      bigint,
      measured_at    timestamptz not null,
      expires_at     timestamptz not null,
      signature      bytea not null
    )`;
  await sql`create index if not exists attestations_provider_idx on attestations (provider_id, expires_at)`;
  await sql`
    create table if not exists offers (
      offer_id       bytea primary key,
      provider_id    bytea not null references providers(provider_id),
      attestation_id bytea not null references attestations(attestation_id),
      template       jsonb not null,
      model          text not null,
      expires_at     timestamptz not null,
      revoked_at     timestamptz,
      created_at     timestamptz not null,
      arch text, core_count int, ram_gib numeric,
      score_single bigint, score_quad bigint, score_eight bigint, score_full bigint,
      score_ram_bandwidth bigint, score_dag_hash bigint
    )`;
  await sql`create index if not exists offers_query_idx on offers (model, arch, score_full, core_count) where revoked_at is null`;
  await sql`create index if not exists offers_provider_idx on offers (provider_id)`;
  await sql`create index if not exists offers_expiry_idx on offers (expires_at)`;

  // Repair: early builds double-encoded jsonb (a jsonb *string* holding JSON,
  // via `${JSON.stringify(x)}::jsonb`), which broke SQL-side `->>` access.
  await sql`update payload_log set payload = (payload #>> '{}')::jsonb where jsonb_typeof(payload) = 'string'`;
  await sql`update offers set template = (template #>> '{}')::jsonb where jsonb_typeof(template) = 'string'`;
}

/** Append a durable object; idempotent on hash. */
export async function logPayload(
  hash: Uint8Array,
  type: string,
  providerId: Uint8Array,
  payload: unknown,
  signature: Uint8Array,
): Promise<void> {
  await sql`
    insert into payload_log (hash, type, provider_id, payload, signature)
    values (${hash}, ${type}, ${providerId}, ${payload as Record<string, unknown>}, ${signature})
    on conflict (hash) do nothing`;
}
