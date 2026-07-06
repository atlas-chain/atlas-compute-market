//! File-based registry transport for containers with no network access.
//!
//! Each round-trip is a pair of JSON files in one exchange directory
//! (normally a bind mount shared with the host-side relay, agent/manager.py):
//!
//!   agent writes   req-<runId>-<n>.json   {"v":1,"id":…,"method":…,"path":…,"body":…}
//!   relay  writes  resp-<runId>-<n>.json  {"status":200,"body":…}
//!                                          {"status":0,"error":"…"}   on transport failure
//!
//! Both sides write via temp-file + rename so a half-written file is never
//! observed; each side deletes the file it consumed. `runId` is the agent's
//! start time in unix ms, so ids never collide with a previous crashed run
//! (the relay also sweeps stale files at startup).
//!
//! The relay is trusted exactly as much as the network path in HTTP mode —
//! every payload is signed inside the container and the attestation/offer
//! responses are verified by the registry, so a hostile relay can at worst
//! deny service or slow the benchmark clock down (lowering scores).

use crate::api::{ApiError, Transport};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long to wait for the relay before giving up. Generous: it also
/// covers "manager not started yet" on container boot.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);
/// Poll interval; also bounds the latency added to server-timed lanes
/// (§5.3) — ~2×10 ms per round-trip against multi-second lanes.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

pub struct FileTransport {
    dir: PathBuf,
    run_id: u64,
    counter: AtomicU64,
}

impl FileTransport {
    pub fn new(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create exchange dir {}: {e}", dir.display()))?;
        let run_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "clock before 1970".to_string())?
            .as_millis() as u64;
        Ok(FileTransport {
            dir: dir.to_path_buf(),
            run_id,
            counter: AtomicU64::new(0),
        })
    }

    fn write_atomic(&self, name: &str, content: &str) -> Result<(), ApiError> {
        let tmp = self.dir.join(format!(".{name}.tmp"));
        let dst = self.dir.join(name);
        std::fs::write(&tmp, content)
            .and_then(|_| std::fs::rename(&tmp, &dst))
            .map_err(|e| ApiError::Transport(format!("writing {}: {e}", dst.display())))
    }
}

impl Transport for FileTransport {
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let id = format!("{}-{:05}", self.run_id, self.counter.fetch_add(1, Ordering::SeqCst));
        let req = json!({ "v": 1, "id": id, "method": method, "path": path, "body": body });
        self.write_atomic(&format!("req-{id}.json"), &req.to_string())?;

        let resp_path = self.dir.join(format!("resp-{id}.json"));
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let text = loop {
            match std::fs::read_to_string(&resp_path) {
                Ok(t) => break t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    if Instant::now() > deadline {
                        let _ = std::fs::remove_file(self.dir.join(format!("req-{id}.json")));
                        return Err(ApiError::Transport(format!(
                            "no response after {}s for {method} {path} — is the manager relay running?",
                            RESPONSE_TIMEOUT.as_secs()
                        )));
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(e) => return Err(ApiError::Transport(format!("reading {}: {e}", resp_path.display()))),
            }
        };
        let _ = std::fs::remove_file(&resp_path);

        let resp: Value =
            serde_json::from_str(&text).map_err(|e| ApiError::Transport(format!("relay response is not JSON: {e}")))?;
        match resp["status"].as_u64().unwrap_or(0) {
            200..=299 => Ok(resp["body"].clone()),
            0 => Err(ApiError::Transport(
                resp["error"].as_str().unwrap_or("relay reported an unspecified transport failure").to_string(),
            )),
            s => Err(ApiError::from_error_body(s as u16, resp["body"].clone())),
        }
    }
}
