//! Atlas Compute Market provider agent.
//!
//! Flow (contract: scripts/bench-client.ts): register profile → open
//! benchmark challenge → solve the four lanes (§5) → publish an offer
//! against the returned attestation → heartbeat dynamic terms.
//!
//! Container-friendly: static binary, hardware auto-detected from /proc,
//! no network beyond BASE_URL. On restart it reuses a still-live
//! attestation instead of burning the challenge quota (§12: 4/day).

use atlas_agent::api::Api;
use atlas_agent::bench::{prove_lane, LaneParams};
use atlas_agent::crypto::{address_from_key, hex_fixed, parse_privkey};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const USAGE: &str = "\
atlas-agent — Atlas Compute Market provider agent

USAGE:
  atlas-agent [--once] [--force-bench] [--exchange DIR]
  atlas-agent --gen-key

FLAGS:
  --once           run the full flow, send one heartbeat, exit
  --force-bench    re-run the benchmark even when a live attestation exists
  --exchange DIR   no network: exchange req-*/resp-*.json files in DIR with a
                   host-side relay (agent/manager.py) instead of using BASE_URL
  --gen-key        generate a provider key, print it with its address, exit

ENVIRONMENT:
  BASE_URL            registry URL           (default http://localhost:8080; unused with --exchange)
  PROVIDER_PRIVKEY    0x-hex secp256k1 key   (required unless a key file is used)
  KEY_FILE            path to load/generate the key when PROVIDER_PRIVKEY is
                      unset (default with --exchange: DIR/provider.key)
  CORE_COUNT          declared cores         (default: available parallelism)
  RAM_GIB             declared RAM in GiB    (default: /proc/meminfo)
  CPU_MODEL           declared CPU model     (default: /proc/cpuinfo)
  MIN_PRICE_PER_HOUR  GLM price string       (default 0.05)
  DISPLAY_NAME        provider display name  (default node-<id>)
  NET_ENDPOINTS       comma-separated list   (default p2p://<id>.example)
  HEARTBEAT_SEC       heartbeat interval     (default 60, clamped to 15..900)
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }
    if args.iter().any(|a| a == "--gen-key") {
        return gen_key();
    }
    let mut once = false;
    let mut force_bench = false;
    let mut exchange: Option<String> = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--once" => once = true,
            "--force-bench" => force_bench = true,
            "--exchange" => match it.next() {
                Some(dir) => exchange = Some(dir.clone()),
                None => {
                    eprintln!("--exchange requires a directory\n\n{USAGE}");
                    return ExitCode::from(2);
                }
            },
            _ => {
                eprintln!("unknown flag {a}\n\n{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    match run(once, force_bench, exchange) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("fatal: {e}");
            ExitCode::FAILURE
        }
    }
}

fn gen_key() -> ExitCode {
    match generate_key() {
        Ok((raw, key)) => {
            println!("PROVIDER_PRIVKEY=0x{}", hex::encode(raw));
            println!("providerId={}", address_from_key(&key));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("fatal: {e}");
            ExitCode::FAILURE
        }
    }
}

fn generate_key() -> Result<([u8; 32], k256::ecdsa::SigningKey), String> {
    loop {
        let mut raw = [0u8; 32];
        getrandom::getrandom(&mut raw).map_err(|_| "OS randomness unavailable".to_string())?;
        // rejection-sample the (astronomically unlikely) out-of-range scalar
        if let Ok(key) = k256::ecdsa::SigningKey::from_slice(&raw) {
            return Ok((raw, key));
        }
    }
}

/// Provider key: PROVIDER_PRIVKEY env wins; otherwise a key file (KEY_FILE,
/// defaulting to <exchange>/provider.key in --exchange mode) is loaded, or
/// generated and persisted on first run so identity survives restarts.
fn load_key(exchange: Option<&str>) -> Result<k256::ecdsa::SigningKey, String> {
    if let Ok(h) = std::env::var("PROVIDER_PRIVKEY") {
        if !h.trim().is_empty() {
            return parse_privkey(&h);
        }
    }
    let key_file = std::env::var("KEY_FILE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| exchange.map(|d| std::path::Path::new(d).join("provider.key")));
    let Some(path) = key_file else {
        return Err("PROVIDER_PRIVKEY required (0x-prefixed 32-byte hex); see --help".to_string());
    };
    match std::fs::read_to_string(&path) {
        Ok(hex_str) => parse_privkey(&hex_str).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let (raw, key) = generate_key()?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            write_key_file(&path, &format!("0x{}\n", hex::encode(raw)))
                .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
            println!("generated new provider key at {}", path.display());
            Ok(key)
        }
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

#[cfg(unix)]
fn write_key_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_key_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
}

fn run(once: bool, force_bench: bool, exchange: Option<String>) -> Result<(), String> {
    let base = env_or("BASE_URL", "http://localhost:8080");
    let key = load_key(exchange.as_deref())?;
    let provider_id = address_from_key(&key);

    let core_count: u32 = env_parse("CORE_COUNT", default_cores())?.min(256);
    let ram_gib: u64 = env_parse("RAM_GIB", detect_ram_gib())?;
    let cpu_model = std::env::var("CPU_MODEL").ok().or_else(detect_cpu_model);
    let price = env_or("MIN_PRICE_PER_HOUR", "0.05");
    let display_name = env_or("DISPLAY_NAME", &format!("node-{}", &provider_id[2..8]));
    let endpoints: Vec<String> = env_or("NET_ENDPOINTS", &format!("p2p://{}.example", &provider_id[2..10]))
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let heartbeat_sec: u64 = env_parse("HEARTBEAT_SEC", 60u64)?.clamp(15, 900);

    let api = match &exchange {
        Some(dir) => {
            println!("provider {provider_id} → file relay at {dir} (no network)");
            Api::over_files(std::path::Path::new(dir), key)?
        }
        None => {
            println!("provider {provider_id} → {base}");
            Api::new(&base, key)
        }
    };
    println!(
        "declaring coreCount={core_count} ramGib={ram_gib} cpuModel={}",
        cpu_model.as_deref().unwrap_or("(none)")
    );

    // Reuse a live attestation when possible: challenge quota is 4/day (§12),
    // and a crash-looping container must not burn through it.
    let (registered, existing) = provider_state(&api, &provider_id);
    let existing = if force_bench { None } else { existing };

    // 1. register/refresh profile (§6.1)
    match api.post(
        "/v1/providers",
        &api.envelope(json!({
            "type": "profile/v1",
            "providerId": provider_id,
            "signedAt": iso_in(0),
            "displayName": display_name,
            "netEndpoints": endpoints,
            "heartbeatIntervalSec": heartbeat_sec,
        })),
    ) {
        Ok(_) => println!("registered provider {provider_id}"),
        Err(e) if e.code() == "STALE_PAYLOAD" => println!("profile kept (a newer one is already stored)"),
        Err(e) if e.code() == "RATE_LIMITED" && registered => println!("profile refresh rate-limited — keeping stored profile"),
        Err(e) => return Err(format!("profile: {e}")),
    }

    // 2–3. attestation: reuse or run the benchmark (§5)
    let attestation_id = match existing {
        Some((id, expires_at)) => {
            println!("reusing live attestation {}… (expires {expires_at})", &id[..18]);
            id
        }
        None => run_benchmark(&api, &provider_id, core_count, ram_gib, cpu_model.as_deref())?,
    };

    // 4. offer referencing the attestation (§6.2); expiry clamps to the attestation's
    let offer = api
        .post(
            "/v1/offers",
            &api.envelope(json!({
                "type": "offer/v1",
                "providerId": provider_id,
                "signedAt": iso_in(0),
                "compute": { "model": "cpu/v1", "attestationId": attestation_id },
                "expiresAt": iso_in(7 * 86_400_000),
            })),
        )
        .map_err(|e| format!("offer: {e}"))?;
    let offer_id = offer["offerId"].as_str().ok_or("offer response missing offerId")?.to_string();
    println!("offer {}…", &offer_id[..18]);

    // 5. heartbeat dynamic terms (§6.3); seq = unix ms → monotonic across restarts
    loop {
        let seq = unix_ms();
        match api.post(
            &format!("/v1/offers/{offer_id}/terms"),
            &api.envelope(json!({
                "type": "terms/v1",
                "providerId": provider_id,
                "offerId": offer_id,
                "seq": seq,
                "signedAt": iso_in(0),
                "validUntil": iso_in(180_000),
                "unit": "GLM",
                "minPricePerHour": price,
                "capacity": { "coresFree": core_count },
            })),
        ) {
            Ok(r) => println!("heartbeat seq={seq} ok (ttl {}ms)", r["expiresInMs"]),
            Err(e) if matches!(e.code(), "REVOKED" | "EXPIRED" | "UNKNOWN_OFFER" | "SIG_MISMATCH") => {
                return Err(format!("heartbeat: {e} — offer is dead"));
            }
            Err(e) => eprintln!("heartbeat failed: {e} (transient, will retry)"),
        }
        if once {
            println!("--once: offer live, exiting");
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(heartbeat_sec));
    }
}

/// GET /v1/providers/{id} → (registered?, live attestation with ≥24 h left).
fn provider_state(api: &Api, provider_id: &str) -> (bool, Option<(String, String)>) {
    let body = match api.get(&format!("/v1/providers/{provider_id}")) {
        Ok(b) => b,
        Err(_) => return (false, None),
    };
    let att = &body["attestation"];
    if att.is_null() || att["model"] != "cpu/v1" {
        return (true, None);
    }
    let reusable = (|| {
        let id = att["id"].as_str()?.to_string();
        let expires_at = att["expiresAt"].as_str()?.to_string();
        let exp = DateTime::parse_from_rfc3339(&expires_at).ok()?;
        // leave margin: an offer published against a nearly-dead attestation
        // would expire under the requestor immediately
        if exp.signed_duration_since(Utc::now()) < chrono::Duration::hours(24) {
            return None;
        }
        Some((id, expires_at))
    })();
    (true, reusable)
}

fn run_benchmark(
    api: &Api,
    provider_id: &str,
    core_count: u32,
    ram_gib: u64,
    cpu_model: Option<&str>,
) -> Result<String, String> {
    let mut request = json!({
        "type": "attest-request/v1",
        "providerId": provider_id,
        "model": "cpu/v1",
        "arch": "x64",
        "coreCount": core_count,
        "ramGib": ram_gib,
        "signedAt": iso_in(0),
    });
    if let Some(m) = cpu_model {
        request["cpuModel"] = json!(m);
    }

    let challenge = match api.post("/v1/attest/challenge", &api.envelope(request)) {
        Ok(c) => c,
        Err(e) if e.code() == "RATE_LIMITED" => {
            // out of challenges for today — any live attestation beats none
            if let (_, Some((id, expires_at))) = provider_state(api, provider_id) {
                println!("challenge rate-limited — falling back to live attestation (expires {expires_at})");
                return Ok(id);
            }
            return Err(format!("challenge: {e} (retryAfterMs={:?})", e.retry_after_ms()));
        }
        Err(e) => return Err(format!("challenge: {e}")),
    };

    let c = &challenge["payload"];
    let challenge_id = c["challengeId"].as_str().ok_or("challenge missing challengeId")?;
    let seed: [u8; 32] = hex_fixed(c["seed"].as_str().ok_or("challenge missing seed")?)?;
    let chain_len = c["chainLen"].as_u64().ok_or("challenge missing chainLen")? as u32;
    let checkpoints = c["checkpoints"].as_u64().ok_or("challenge missing checkpoints")? as u32;
    let samples = c["samples"].as_u64().ok_or("challenge missing samples")? as u32;
    println!(
        "challenge {}… chainLen={chain_len} C={checkpoints} K={samples}",
        &challenge_id[..18]
    );
    let challenge_raw: [u8; 32] = hex_fixed(challenge_id)?;
    let provider_raw: [u8; 20] = hex_fixed(provider_id)?;

    let mut attestation: Option<Value> = None;
    for lane in c["lanes"].as_array().ok_or("challenge missing lanes")? {
        let lane_id = lane["laneId"].as_str().ok_or("lane missing laneId")?;
        let workers = lane["workers"].as_u64().ok_or("lane missing workers")? as u32;

        let start = api
            .post(&format!("/v1/attest/{challenge_id}/lane/{lane_id}/start"), &json!({}))
            .map_err(|e| format!("start {lane_id}: {e}"))?;
        let lane_nonce: [u8; 16] = hex_fixed(start["laneNonce"].as_str().ok_or("start missing laneNonce")?)?;

        let params = LaneParams {
            seed,
            lane_nonce,
            provider_id: provider_raw,
            lane_id: lane_id.to_string(),
            chain_len,
            checkpoints,
            samples,
        };
        let t0 = Instant::now();
        let proofs = prove_lane(&params, workers, &challenge_raw);
        let local_ms = t0.elapsed().as_millis();

        let resp = api
            .post(
                &format!("/v1/attest/{challenge_id}/lane/{lane_id}"),
                &api.envelope(json!({
                    "type": "lane-proof/v1",
                    "providerId": provider_id,
                    "challengeId": challenge_id,
                    "laneId": lane_id,
                    "workers": proofs,
                })),
            )
            .map_err(|e| format!("submit {lane_id}: {e}"))?;
        println!(
            "lane {lane_id}: {workers}w computed in {local_ms}ms, server elapsed {}ms",
            resp["elapsedMs"]
        );
        if !resp["attestation"].is_null() {
            attestation = Some(resp["attestation"].clone());
        }
    }

    let att = attestation.ok_or("no attestation returned on final lane")?;
    let id = att["attestationId"].as_str().ok_or("attestation missing attestationId")?.to_string();
    println!("attestation {}… scores={}", &id[..18], att["envelope"]["payload"]["scores"]);
    Ok(id)
}

// ------------------------------------------------------------------ util

fn iso_in(ms_from_now: i64) -> String {
    (Utc::now() + chrono::Duration::milliseconds(ms_from_now)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).expect("clock before 1970").as_millis() as u64
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| default.to_string())
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => v.trim().parse().map_err(|_| format!("{name}={v:?} is not a valid number")),
        _ => Ok(default),
    }
}

fn default_cores() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4)
}

fn detect_ram_gib() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("MemTotal:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<u64>().ok())
        })
        .map(|kb| ((kb as f64) / (1024.0 * 1024.0)).round().max(1.0) as u64)
        .unwrap_or(16)
}

fn detect_cpu_model() -> Option<String> {
    let s = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    let line = s.lines().find(|l| l.starts_with("model name"))?;
    let model = line.split(':').nth(1)?.trim();
    if model.is_empty() {
        None
    } else {
        Some(model.chars().take(128).collect())
    }
}
