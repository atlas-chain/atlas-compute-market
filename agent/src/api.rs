//! Registry HTTP client — the provider flow of scripts/bench-client.ts
//! against the §8 endpoints. Plain blocking HTTP; the only network the
//! agent ever touches is BASE_URL.

use crate::crypto::sign_payload;
use k256::ecdsa::SigningKey;
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;

pub struct Api {
    agent: ureq::Agent,
    base: String,
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
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Http { status, code, message, .. } => write!(f, "{status} {code}: {message}"),
            ApiError::Transport(msg) => write!(f, "transport: {msg}"),
        }
    }
}

impl Api {
    pub fn new(base: &str, key: SigningKey) -> Self {
        Api {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .timeout(Duration::from_secs(120))
                .build(),
            base: base.trim_end_matches('/').to_string(),
            key,
        }
    }

    /// { payload, signature } wrapper (§3.4).
    pub fn envelope(&self, payload: Value) -> Value {
        let signature = sign_payload(&payload, &self.key);
        json!({ "payload": payload, "signature": signature })
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        match self.agent.post(&format!("{}{}", self.base, path)).send_json(body) {
            Ok(resp) => resp.into_json().map_err(|e| ApiError::Transport(e.to_string())),
            Err(ureq::Error::Status(_, resp)) => Err(Self::error_from(resp)),
            Err(e) => Err(ApiError::Transport(e.to_string())),
        }
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        match self.agent.get(&format!("{}{}", self.base, path)).call() {
            Ok(resp) => resp.into_json().map_err(|e| ApiError::Transport(e.to_string())),
            Err(ureq::Error::Status(_, resp)) => Err(Self::error_from(resp)),
            Err(e) => Err(ApiError::Transport(e.to_string())),
        }
    }

    fn error_from(resp: ureq::Response) -> ApiError {
        let status = resp.status();
        let body: Value = resp.into_json().unwrap_or(Value::Null);
        let err = &body["error"];
        ApiError::Http {
            status,
            code: err["code"].as_str().unwrap_or("UNKNOWN").to_string(),
            message: err["message"].as_str().unwrap_or("(no error message)").to_string(),
            details: err.get("details").cloned().unwrap_or(Value::Null),
        }
    }
}
