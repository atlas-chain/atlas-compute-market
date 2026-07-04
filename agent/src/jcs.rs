//! RFC 8785 (JCS) canonical JSON — port of src/jcs.ts.
//!
//! Restriction beyond the TS reference: numbers must be integers with
//! |n| ≤ 2^53. Every number in Atlas payloads is a small integer, and
//! integers in that range print identically under ES shortest-form and
//! Rust's decimal formatting; supporting floats would require a full
//! ES number-to-string port, so they are rejected instead.

use serde_json::Value;
use std::cmp::Ordering;

pub fn jcs(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    serialize(value, &mut out)?;
    Ok(out)
}

fn serialize(v: &Value, out: &mut String) -> Result<(), String> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let i = n.as_i64().ok_or_else(|| format!("non-integer number in payload: {n}"))?;
            if i.unsigned_abs() > 1 << 53 {
                return Err(format!("number outside ±2^53: {i}"));
            }
            out.push_str(&i.to_string());
        }
        Value::String(s) => escape_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                serialize(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| utf16_cmp(a.0, b.0));
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                escape_string(k, out);
                out.push(':');
                serialize(val, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// RFC 8785 §3.2.3: member ordering is by UTF-16 code units — NOT by code
/// points; supplementary-plane characters (surrogate pairs) sort below
/// U+E000..U+FFFF. Matches Array.prototype.sort() on JS strings.
fn utf16_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JSON.stringify string serialization: two-char escapes for the usual
/// suspects, lowercase \u00xx for remaining control chars, everything
/// else (including all non-ASCII) emitted literally.
fn escape_string(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
