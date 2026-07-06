//! Register the provider from inside a Golem VM — no yagna needed.
//!
//! Drives ya-runtime-vm standalone over its runtime API (stdio protocol):
//! `deploy` the GVMI image, `start` the VM, then `run` the agent with
//! `--exchange /exchange`. The VM has no NIC at all; the agent's registry
//! traffic comes out as req-*.json files on the 9p-mounted exchange volume,
//! which this driver relays to the registry over HTTPS (same file protocol
//! as agent/manager.py, see agent/src/file_transport.rs).
//!
//! The image must declare `VOLUME /exchange` (agent/Dockerfile does).

use anyhow::{anyhow, bail, Context as _};
use futures::future::BoxFuture;
use futures::FutureExt;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use ya_runtime_api::server::{self, ProcessStatus, RuntimeControl, RuntimeHandler, RuntimeService, RuntimeStatus};

const USAGE: &str = "\
atlas-vm-driver — run the offline provider agent inside ya-runtime-vm

USAGE:
  atlas-vm-driver --runtime PATH --image PATH --workdir DIR [OPTIONS] [-- AGENT_ARGS...]

OPTIONS:
  --runtime PATH      ya-runtime-vm binary (from the release tarball)
  --image PATH        provider .gvmi image (gvmkit-build output)
  --workdir DIR       working directory for the deployment (created)
  --base-url URL      registry to relay to (default https://compute-market.arkiv-global.net)
  --cpu-cores N       VM logical cores (default 2); also the declared CORE_COUNT
  --mem-gib N         VM RAM in GiB (default 2); also the declared RAM_GIB
  --storage-gib N     VM storage in GiB (default 2)
  --env K=V           extra agent environment (repeatable), e.g. MIN_PRICE_PER_HOUR=0.1
  AGENT_ARGS          after `--`, passed to atlas-agent (e.g. --once --force-bench)
";

const DEFAULT_BASE_URL: &str = "https://compute-market.arkiv-global.net";
const AGENT_BIN: &str = "/usr/local/bin/atlas-agent";
const EXCHANGE_MOUNT: &str = "/exchange";
const RELAY_POLL: std::time::Duration = std::time::Duration::from_millis(10);

struct Args {
    runtime: PathBuf,
    image: PathBuf,
    workdir: PathBuf,
    base_url: String,
    cpu_cores: u32,
    mem_gib: f64,
    storage_gib: f64,
    env: Vec<(String, String)>,
    agent_args: Vec<String>,
}

fn parse_args() -> anyhow::Result<Args> {
    let mut args = Args {
        runtime: PathBuf::new(),
        image: PathBuf::new(),
        workdir: PathBuf::new(),
        base_url: DEFAULT_BASE_URL.to_string(),
        cpu_cores: 2,
        mem_gib: 2.0,
        storage_gib: 2.0,
        env: Vec::new(),
        agent_args: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let mut val = |name: &str| it.next().ok_or_else(|| anyhow!("{name} requires a value"));
        match a.as_str() {
            "--help" | "-h" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--runtime" => args.runtime = val("--runtime")?.into(),
            "--image" => args.image = val("--image")?.into(),
            "--workdir" => args.workdir = val("--workdir")?.into(),
            "--base-url" => args.base_url = val("--base-url")?,
            "--cpu-cores" => args.cpu_cores = val("--cpu-cores")?.parse().context("--cpu-cores")?,
            "--mem-gib" => args.mem_gib = val("--mem-gib")?.parse().context("--mem-gib")?,
            "--storage-gib" => args.storage_gib = val("--storage-gib")?.parse().context("--storage-gib")?,
            "--env" => {
                let kv = val("--env")?;
                let (k, v) = kv.split_once('=').ok_or_else(|| anyhow!("--env expects K=V, got {kv:?}"))?;
                args.env.push((k.to_string(), v.to_string()));
            }
            "--" => {
                args.agent_args = it.by_ref().collect();
                break;
            }
            other => bail!("unknown flag {other}\n\n{USAGE}"),
        }
    }
    for (flag, p) in [("--runtime", &args.runtime), ("--image", &args.image), ("--workdir", &args.workdir)] {
        if p.as_os_str().is_empty() {
            bail!("{flag} is required\n\n{USAGE}");
        }
    }
    Ok(args)
}

/// Common CLI prefix for both `deploy` and `start` runtime invocations.
fn runtime_cli(args: &Args) -> Vec<String> {
    vec![
        "--workdir".into(),
        args.workdir.display().to_string(),
        "--task-package".into(),
        args.image.display().to_string(),
        "--cpu-cores".into(),
        args.cpu_cores.to_string(),
        "--mem-gib".into(),
        args.mem_gib.to_string(),
        "--storage-gib".into(),
        args.storage_gib.to_string(),
    ]
}

/// Run `deploy` (or reuse the workdir's existing deployment — volume names
/// are random per deploy, and the provider key lives in the exchange volume,
/// so re-deploying would mint a new identity) and locate the host directory
/// that gets 9p-mounted at /exchange in the guest.
fn deploy(args: &mut Args) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(&args.workdir)?;
    // vmrt executes from the runtime's own directory, so every path the
    // runtime receives must survive a cwd change
    args.workdir = args.workdir.canonicalize().context("resolving --workdir")?;
    args.image = args.image.canonicalize().context("resolving --image")?;
    args.runtime = args.runtime.canonicalize().context("resolving --runtime")?;

    let depl_file = args.workdir.join("deployment.json");
    let vols = if depl_file.exists() {
        println!("[driver] reusing deployment in {} (delete it for a fresh identity)", args.workdir.display());
        let depl: Value = serde_json::from_str(&std::fs::read_to_string(&depl_file)?)
            .with_context(|| format!("parsing {}", depl_file.display()))?;
        depl["volumes"].as_array().cloned().unwrap_or_default()
    } else {
        let out = std::process::Command::new(&args.runtime)
            .args(runtime_cli(args))
            .arg("deploy")
            .output()
            .with_context(|| format!("spawning {}", args.runtime.display()))?;
        if !out.status.success() {
            bail!("deploy failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        // the DeployResult JSON is the last non-empty stdout line (logs go to file)
        let json_line = stdout
            .lines()
            .rev()
            .find(|l| l.trim_start().starts_with('{'))
            .ok_or_else(|| anyhow!("no JSON in deploy output:\n{stdout}"))?;
        let result: Value = serde_json::from_str(json_line).context("parsing DeployResult")?;
        result["vols"].as_array().cloned().unwrap_or_default()
    };
    let vol = vols
        .iter()
        .find(|v| v["path"] == EXCHANGE_MOUNT)
        .ok_or_else(|| anyhow!("image declares no VOLUME {EXCHANGE_MOUNT} (vols: {vols:?}) — rebuild it from agent/Dockerfile"))?;
    let name = vol["name"].as_str().ok_or_else(|| anyhow!("volume entry without name"))?;
    let host_dir = args.workdir.join(name);
    // the guest agent runs as the image user via 9p (security_model=none):
    // host-side permission checks happen with the VM process' uid, but make
    // the directory world-writable so a restarted VM under another uid still works
    let _ = std::fs::set_permissions(&host_dir, std::os::unix::fs::PermissionsExt::from_mode(0o777));
    Ok(host_dir)
}

// ------------------------------------------------------------------ relay

/// Forward one req-*.json to the registry (same rules as manager.py).
fn forward(base_url: &str, req: &Value) -> Value {
    let path = req["path"].as_str().unwrap_or("");
    let method = req["method"].as_str().unwrap_or("");
    if !path.starts_with("/v1/") || !matches!(method, "GET" | "POST") {
        return serde_json::json!({ "status": 0, "error": format!("relay refused {method} {path:?}: only GET/POST /v1/* is allowed") });
    }
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let result = match method {
        "GET" => ureq::get(&url).call(),
        _ => ureq::post(&url).send_json(&req["body"]),
    };
    match result {
        Ok(resp) => {
            let status = resp.status();
            match resp.into_json::<Value>() {
                Ok(body) => serde_json::json!({ "status": status, "body": body }),
                Err(e) => serde_json::json!({ "status": 0, "error": format!("non-JSON response: {e}") }),
            }
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_json::<Value>().unwrap_or(Value::Null);
            serde_json::json!({ "status": status, "body": body })
        }
        Err(e) => serde_json::json!({ "status": 0, "error": e.to_string() }),
    }
}

fn relay_pending(dir: &Path, base_url: &str) -> anyhow::Result<usize> {
    let mut reqs: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("req-") && n.ends_with(".json"))
        })
        .collect();
    reqs.sort();
    let handled = reqs.len();
    for req_path in reqs {
        let req: Value = match std::fs::read_to_string(&req_path).map_err(anyhow::Error::from).and_then(|t| Ok(serde_json::from_str(&t)?)) {
            Ok(v) => v,
            Err(_) => continue, // written via rename; transient read races only
        };
        let resp = forward(base_url, &req);
        let status = resp["status"].as_u64().unwrap_or(0);
        let note = if status == 0 { format!(" ({})", resp["error"]) } else { String::new() };
        println!("[relay] {} {} → {}{note}", req["method"].as_str().unwrap_or("?"), req["path"].as_str().unwrap_or("?"), status);
        let id = req["id"].as_str().unwrap_or_default();
        let tmp = dir.join(format!(".resp-{id}.json.tmp"));
        std::fs::write(&tmp, resp.to_string())?;
        std::fs::rename(&tmp, dir.join(format!("resp-{id}.json")))?;
        let _ = std::fs::remove_file(&req_path);
    }
    Ok(handled)
}

// ------------------------------------------------------- runtime events

#[derive(Default)]
struct Exits {
    codes: Mutex<HashMap<u64, i32>>,
    notify: tokio::sync::Notify,
}

struct Handler(Arc<Exits>);

impl RuntimeHandler for Handler {
    fn on_process_status<'a>(&self, status: ProcessStatus) -> BoxFuture<'a, ()> {
        for (stream, bytes) in [("vm", &status.stdout), ("vm!", &status.stderr)] {
            let text = String::from_utf8_lossy(bytes);
            for line in text.lines().filter(|l| !l.trim().is_empty()) {
                println!("[{stream}] {line}");
            }
        }
        if !status.running {
            self.0.codes.lock().unwrap().insert(status.pid, status.return_code);
            self.0.notify.notify_waiters();
        }
        futures::future::ready(()).boxed()
    }

    fn on_runtime_status<'a>(&self, _: RuntimeStatus) -> BoxFuture<'a, ()> {
        futures::future::ready(()).boxed()
    }
}

// --------------------------------------------------------------- main

/// Build the RunProcess for the agent, via `sh -c` when env vars are needed
/// (the runtime API carries no environment; the image env is fixed).
fn agent_process(args: &Args) -> server::RunProcess {
    let agent_args = args.agent_args.join(" ");
    if args.env.is_empty() {
        let mut argv = vec!["atlas-agent".to_string(), "--exchange".into(), EXCHANGE_MOUNT.into()];
        argv.extend(args.agent_args.iter().cloned());
        server::RunProcess { bin: AGENT_BIN.into(), args: argv, ..Default::default() }
    } else {
        let exports: String = args
            .env
            .iter()
            .map(|(k, v)| format!("{k}='{}' ", v.replace('\'', "'\\''")))
            .collect();
        let cmd = format!("{exports}exec {AGENT_BIN} --exchange {EXCHANGE_MOUNT} {agent_args}");
        server::RunProcess {
            bin: "/bin/sh".into(),
            args: vec!["sh".into(), "-c".into(), cmd],
            ..Default::default()
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let mut args = parse_args()?;

    let exchange = deploy(&mut args)?;
    println!("[driver] deployed; exchange dir: {}", exchange.display());
    println!("[driver] relaying to {}", args.base_url);

    // relay runs on a plain thread (blocking HTTP) for the driver's lifetime
    {
        let (dir, base) = (exchange.clone(), args.base_url.clone());
        std::thread::spawn(move || loop {
            match relay_pending(&dir, &base) {
                Ok(0) => std::thread::sleep(RELAY_POLL),
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[relay] error: {e}");
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            }
        });
    }

    let exits = Arc::new(Exits::default());
    let mut cmd = tokio::process::Command::new(&args.runtime);
    cmd.args(runtime_cli(&args)).arg("start");
    println!("[driver] starting VM ({} cores, {} GiB) …", args.cpu_cores, args.mem_gib);
    let service = server::spawn(cmd, Handler(exits.clone()))
        .await
        .map_err(|e| anyhow!("starting ya-runtime-vm: {e}"))?;
    // hello() answers only once runtime.start() finished, i.e. the VM is booted
    tokio::select! {
        r = service.hello("0.1.0") => { r.map_err(|e| anyhow!("handshake: {e:?}"))?; }
        code = service.stopped() => bail!("ya-runtime-vm exited during boot (code {code}) — see its logs above"),
        _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => bail!("timed out waiting for the VM to boot"),
    }
    println!("[driver] VM up, running agent …");

    let run = agent_process(&args);
    let pid = service.run_process(run).await.map_err(|e| anyhow!("run agent: {e:?}"))?.pid;

    let code = tokio::select! {
        code = async {
            loop {
                if let Some(code) = exits.codes.lock().unwrap().get(&pid).copied() {
                    return code;
                }
                exits.notify.notified().await;
            }
        } => {
            println!("[driver] agent exited with code {code}");
            code
        }
        _ = tokio::signal::ctrl_c() => {
            println!("\n[driver] interrupted — stopping agent and VM …");
            let _ = service.kill_process(server::KillProcess { pid, signal: 15 }).await;
            130
        }
    };

    let _ = service.shutdown().await;
    std::process::exit(code);
}
