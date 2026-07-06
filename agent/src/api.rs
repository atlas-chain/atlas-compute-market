//! Registry client — the provider flow of scripts/bench-client.ts against
//! the §8 endpoints, over a pluggable transport:
//!
//!  - `HttpTransport`: plain blocking HTTP; the only network the agent
//!    ever touches is BASE_URL.
//!  - `FileTransport` (file_transport.rs): request/response JSON files in
//!    an exchange directory, relayed by a host-side manager — for
//!    containers that must run with no network at all.

use crate::crypto::sign_payload;
use k256::ecdsa::SigningKey;
use serde_json::{json, Value};
use std::fmt;
use std::path::Path;
use std::time::Duration;

/// One registry round-trip. `body` is `Some` for POST, `None` for GET.
pub trait Transport {
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError>;
}

pub struct Api {
    transport: Box<dyn Transport>,
    key: SigningKey,
}

#[derive(Debug)]
pub enum ApiError {
    /// Registry error envelope (§13): { error: { code, message, details? } }.
    Http {
        status: u16,
        code: String,
        message: String,
        details: Value,
    },
    Transport(String),
}

impl ApiError {
    pub fn code(&self) -> &str {
        match self {
            ApiError::Http { code, .. } => code,
            ApiError::Transport(_) => "",
        }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            ApiError::Http { details, .. } => details.get("retryAfterMs").and_then(Value::as_u64),
            ApiError::Transport(_) => None,
        }
    }

    /// Build the Http variant from a §13 error body (shared by transports).
    pub fn from_error_body(status: u16, body: Value) -> ApiError {
        let err = &body["error"];
        ApiError::Http {
            status,
            code: err["code"].as_str().unwrap_or("UNKNOWN").to_string(),
            message: err["message"].as_str().unwrap_or("(no error message)").to_string(),
            details: err.get("details").cloned().unwrap_or(Value::Null),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Http { status, code, message, .. } => write!(f, "{status} {code}: {message}"),
            ApiError::Transport(msg) => write!(f, "transport: {msg}"),
        }
    }
}

pub struct HttpTransport {
    agent: ureq::Agent,
    base: String,
}

impl HttpTransport {
    pub fn new(base: &str) -> Self {
        HttpTransport {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .timeout(Duration::from_secs(120))
                .build(),
            base: base.trim_end_matches('/').to_string(),
        }
    }
}

impl Transport for HttpTransport {
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let url = format!("{}{}", self.base, path);
        let result = match (method, body) {
            ("GET", _) => self.agent.get(&url).call(),
            (_, Some(b)) => self.agent.post(&url).send_json(b),
            (m, None) => return Err(ApiError::Transport(format!("{m} without body"))),
        };
        match result {
            Ok(resp) => resp.into_json().map_err(|e| ApiError::Transport(e.to_string())),
            Err(ureq::Error::Status(status, resp)) => {
                let body: Value = resp.into_json().unwrap_or(Value::Null);
                Err(ApiError::from_error_body(status, body))
            }
            Err(e) => Err(ApiError::Transport(e.to_string())),
        }
    }
}

impl Api {
    pub fn new(base: &str, key: SigningKey) -> Self {
        Api {
            transport: Box::new(HttpTransport::new(base)),
            key,
        }
    }

    /// File-relayed transport for network-less containers (see manager.py).
    pub fn over_files(dir: &Path, key: SigningKey) -> Result<Self, String> {
        Ok(Api {
            transport: Box::new(crate::file_transport::FileTransport::new(dir)?),
            key,
        })
    }

    /// { payload, signature } wrapper (§3.4).
    pub fn envelope(&self, payload: Value) -> Value {
        let signature = sign_payload(&payload, &self.key);
        json!({ "payload": payload, "signature": signature })
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        self.transport.request("POST", path, Some(body))
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.transport.request("GET", path, None)
    }
}
