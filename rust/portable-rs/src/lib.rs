//! JS bindings for `rayu/src/core/portable/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod port;
pub mod utf16;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `djb2Hash`.
#[napi(js_name = "djb2Hash")]
pub fn djb2_hash(str: String) -> napi::Result<f64> {
    run(move || {
        let out = port::djb2_hash(str)?;
        Ok(out)
    })
}

/// `hashContent`.
#[napi(js_name = "hashContent")]
pub fn hash_content(content: String) -> napi::Result<String> {
    run(move || {
        let out = port::hash_content(content)?;
        Ok(out)
    })
}

/// `hashPair`.
#[napi(js_name = "hashPair")]
pub fn hash_pair(a: String, b: String) -> napi::Result<String> {
    run(move || {
        let out = port::hash_pair(a, b)?;
        Ok(out)
    })
}
