//! JS bindings for `rayu/src/core/`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;

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

/// `resolveBuildConfig`.
#[napi(js_name = "resolveBuildConfig")]
pub fn resolve_build_config(env: String, version: String) -> napi::Result<String> {
    run(move || {
        let env = crate::js::from_json(&env)?;
        let out = port::resolve_build_config(env, version)?;
        crate::js::to_json(&out)
    })
}

/// `isEnvTruthy`.
#[napi(js_name = "isEnvTruthy")]
pub fn is_env_truthy(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::is_env_truthy(value)?;
        Ok(out)
    })
}

/// `resolveEndpoints`.
#[napi(js_name = "resolveEndpoints")]
pub fn resolve_endpoints(env: String, baked: String) -> napi::Result<String> {
    run(move || {
        let env = crate::js::from_json(&env)?;
        let baked = crate::js::from_json(&baked)?;
        let out = port::resolve_endpoints(env, baked)?;
        crate::js::to_json(&out)
    })
}

/// `getBakedBuildConfig`.
#[napi(js_name = "getBakedBuildConfig")]
pub fn get_baked_build_config() -> napi::Result<String> {
    run(move || {
        let out = port::get_baked_build_config()?;
        crate::js::to_json(&out)
    })
}

/// `buildFeatureTable`.
#[napi(js_name = "buildFeatureTable")]
pub fn build_feature_table(all_flags: Vec<String>, enabled: String) -> napi::Result<String> {
    run(move || {
        let enabled = crate::js::from_json(&enabled)?;
        let out = port::build_feature_table(all_flags, enabled)?;
        crate::js::to_json(&out)
    })
}

/// `installFeatureTable`.
#[napi(js_name = "installFeatureTable")]
pub fn install_feature_table(_table: String) -> napi::Result<()> {
    run(move || {
        let _table = crate::js::from_json(&_table)?;
        port::install_feature_table(_table)?;
        Ok(())
    })
}

// ---- the binary wire ------------------------------------------------------------------------

thread_local! {
    static WIRE: std::cell::RefCell<Option<(napi::bindgen_prelude::Uint8Array, napi::bindgen_prelude::Uint8Array)>> =
        const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument and result buffers `index.cjs` writes to and reads from.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(
    input: napi::bindgen_prelude::Uint8Array,
    output: napi::bindgen_prelude::Uint8Array,
) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads `len` argument bytes, runs `f`, and writes its result; a negative return is the size
/// of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(
    len: u32,
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output)) = guard.as_mut() else {
            return Err(napi::Error::from_reason(
                "rust-anything: the wire buffers are not registered",
            ));
        };
        let len = (len as usize).min(input.len());
        let mut w = wire::Writer::default();
        match run(|| f(&mut wire::Reader::new(&input[..len]), &mut w)) {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => return Ok(f64::NAN),
            other => other?,
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        Ok(n as f64)
    })
}

static S_RESOLVE_BUILD_CONFIG_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_BUILD_CONFIG_OUT: wire::Schema = wire::Schema::Obj(&[
    ("VERSION", wire::Schema::Str16),
    ("BUILD_TIME", wire::Schema::Str16),
    ("PACKAGE_URL", wire::Schema::Str16),
    ("NATIVE_PACKAGE_URL", wire::Schema::Str16),
    ("FEEDBACK_CHANNEL", wire::Schema::Str16),
    ("ISSUES_EXPLAINER", wire::Schema::Str16),
    ("VERSION_CHANGELOG", wire::Schema::Str16),
    ("RAYU_OAUTH_DEFAULT", wire::Schema::Str16),
    ("RAYU_API_URL", wire::Schema::Str16),
    ("RAYU_WEB_URL", wire::Schema::Str16),
    ("RAYU_GATEWAY_URL", wire::Schema::Str16),
]);

/// `resolveBuildConfig` over the binary wire.
#[napi(js_name = "resolveBuildConfigWire")]
pub fn resolve_build_config_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let env: serde_json::Value = wire::read_value(r, &S_RESOLVE_BUILD_CONFIG_0)?;
        let version: String = r.string16()?;
        let out = &port::resolve_build_config(env, version)?;
        wire::write_value(w, out, &S_RESOLVE_BUILD_CONFIG_OUT)?;
        Ok(())
    })
}

static S_IS_ENV_TRUTHY_0: wire::Schema = wire::Schema::Dyn;

/// `isEnvTruthy` over the binary wire.
#[napi(js_name = "isEnvTruthyWire")]
pub fn is_env_truthy_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_IS_ENV_TRUTHY_0)?;
        let out = &port::is_env_truthy(value)?;
        w.bool(*out);
        Ok(())
    })
}

static S_RESOLVE_ENDPOINTS_0: wire::Schema = wire::Schema::Dyn;
static S_RESOLVE_ENDPOINTS_1: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("VERSION", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("BUILD_TIME", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("PACKAGE_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "NATIVE_PACKAGE_URL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "FEEDBACK_CHANNEL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "ISSUES_EXPLAINER",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "VERSION_CHANGELOG",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "RAYU_OAUTH_DEFAULT",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    ("RAYU_API_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("RAYU_WEB_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "RAYU_GATEWAY_URL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
]));
static S_RESOLVE_ENDPOINTS_OUT: wire::Schema = wire::Schema::Obj(&[
    ("apiBaseUrl", wire::Schema::Str16),
    ("webBaseUrl", wire::Schema::Str16),
    ("gatewayBaseUrl", wire::Schema::Str16),
]);

/// `resolveEndpoints` over the binary wire.
#[napi(js_name = "resolveEndpointsWire")]
pub fn resolve_endpoints_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let env: serde_json::Value = wire::read_value(r, &S_RESOLVE_ENDPOINTS_0)?;
        let baked: Option<serde_json::Value> =
            r.opt_js(|r| wire::read_value(r, S_RESOLVE_ENDPOINTS_1.inner()))?;
        let out = &port::resolve_endpoints(env, baked)?;
        wire::write_value(w, out, &S_RESOLVE_ENDPOINTS_OUT)?;
        Ok(())
    })
}

static S_GET_BAKED_BUILD_CONFIG_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("VERSION", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("BUILD_TIME", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("PACKAGE_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "NATIVE_PACKAGE_URL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "FEEDBACK_CHANNEL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "ISSUES_EXPLAINER",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "VERSION_CHANGELOG",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    (
        "RAYU_OAUTH_DEFAULT",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    ("RAYU_API_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("RAYU_WEB_URL", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "RAYU_GATEWAY_URL",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
]));

/// `getBakedBuildConfig` over the binary wire.
#[napi(js_name = "getBakedBuildConfigWire")]
pub fn get_baked_build_config_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |_r, w| {
        let out = &port::get_baked_build_config()?;
        wire::write_value(w, out, &S_GET_BAKED_BUILD_CONFIG_OUT)?;
        Ok(())
    })
}

static S_BUILD_FEATURE_TABLE_1: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Str16));
static S_BUILD_FEATURE_TABLE_OUT: wire::Schema = wire::Schema::Map16(&wire::Schema::Bool);

/// `buildFeatureTable` over the binary wire.
#[napi(js_name = "buildFeatureTableWire")]
pub fn build_feature_table_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, w| {
        let all_flags: Vec<String> = r.list(|r| r.string16())?;
        let enabled: Option<serde_json::Value> =
            r.opt_js(|r| wire::read_value(r, S_BUILD_FEATURE_TABLE_1.inner()))?;
        let out = &port::build_feature_table(all_flags, enabled)?;
        wire::write_value(w, out, &S_BUILD_FEATURE_TABLE_OUT)?;
        Ok(())
    })
}

static S_INSTALL_FEATURE_TABLE_0: wire::Schema = wire::Schema::Dyn;

/// `installFeatureTable` over the binary wire.
#[napi(js_name = "installFeatureTableWire")]
pub fn install_feature_table_wire(len: u32) -> napi::Result<f64> {
    wire_io(len, |r, _w| {
        let _table: serde_json::Value = wire::read_value(r, &S_INSTALL_FEATURE_TABLE_0)?;
        let () = port::install_feature_table(_table)?;
        Ok(())
    })
}
