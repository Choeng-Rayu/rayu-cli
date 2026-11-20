//! The Rust port of `rayu/src/core/`.
//!
//! `src/core` is pure functions over an env record, plus the three build-time
//! constants. JS value semantics matter here: `??` vs `||`, property access on
//! primitives, `Object` key ordering, and the exact TypeError text are all part
//! of the recorded behavior.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, HashMap};

const ENABLED_FEATURES: [&str; 4] = [
    "ULTRATHINK",
    "TOKEN_BUDGET",
    "BUILTIN_EXPLORE_PLAN_AGENTS",
    "EXTERNAL_AGENTS",
];

fn is_undefined(value: &serde_json::Value) -> bool {
    crate::js::is_undefined(value)
}

fn undefined() -> serde_json::Value {
    crate::js::undefined()
}

/// Port of `resolveBuildConfig` (`rayu/src/core/buildConfig.ts:108`).
pub fn resolve_build_config(
    env: serde_json::Value,
    version: String,
) -> Result<serde_json::Value, String> {
    let oauth = first_nullish(
        prop(&env, "RAYU_BUILD_OAUTH")?,
        prop(&env, "USE_RAYU_OAUTH")?,
    )
    .unwrap_or_else(|| serde_json::Value::String("true".to_string()));
    let api = first_nullish(
        prop(&env, "RAYU_BUILD_API_URL")?,
        prop(&env, "RAYU_API_URL")?,
    )
    .unwrap_or_else(|| json_string("https://api.rayucode.com/api"));
    let web = first_nullish(
        prop(&env, "RAYU_BUILD_WEB_URL")?,
        prop(&env, "RAYU_WEB_URL")?,
    )
    .unwrap_or_else(|| json_string("https://rayucode.com"));
    let gateway = first_nullish(
        prop(&env, "RAYU_BUILD_GATEWAY_URL")?,
        prop(&env, "RAYU_GATEWAY_URL")?,
    )
    .unwrap_or_else(|| json_string("https://gateway.rayucode.com"));

    Ok(serde_json::json!({
        "VERSION": version,
        "BUILD_TIME": "",
        "PACKAGE_URL": "@rayu-dev/rayu-cli",
        "NATIVE_PACKAGE_URL": "@rayu-dev/rayu-cli",
        "FEEDBACK_CHANNEL": "https://github.com/Choeng-Rayu/rayu-cli/issues",
        "ISSUES_EXPLAINER": "report the issue at https://github.com/Choeng-Rayu/rayu-cli/issues",
        "VERSION_CHANGELOG": "",
        "RAYU_OAUTH_DEFAULT": oauth,
        "RAYU_API_URL": api,
        "RAYU_WEB_URL": web,
        "RAYU_GATEWAY_URL": gateway,
    }))
}

/// Port of `isEnvTruthy` (`rayu/src/core/buildConfig.ts:140`).
pub fn is_env_truthy(value: serde_json::Value) -> Result<bool, String> {
    if is_falsy(&value) {
        return Ok(false);
    }
    match &value {
        serde_json::Value::Bool(b) => Ok(*b),
        serde_json::Value::String(s) => {
            let folded = js_trim(&js_to_lowercase(s));
            Ok(matches!(folded.as_str(), "1" | "true" | "yes" | "on"))
        }
        _ => Err("value.toLowerCase is not a function".to_string()),
    }
}

/// Port of `resolveEndpoints` (`rayu/src/core/buildConfig.ts:167`).
pub fn resolve_endpoints(
    env: serde_json::Value,
    baked: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    // `env.RAYU_API_URL` is read first, so a nullish `env` throws with that key.
    let api_env = prop(&env, "RAYU_API_URL")?;
    let api = resolve_endpoint(
        api_env,
        baked_value(baked.as_ref(), "RAYU_API_URL")?,
        "http://localhost:4000/api",
    )?;
    let web = resolve_endpoint(
        prop(&env, "RAYU_WEB_URL")?,
        baked_value(baked.as_ref(), "RAYU_WEB_URL")?,
        "http://localhost:3000",
    )?;
    let gateway = resolve_endpoint(
        prop(&env, "RAYU_GATEWAY_URL")?,
        baked_value(baked.as_ref(), "RAYU_GATEWAY_URL")?,
        "http://localhost:8080",
    )?;

    Ok(serde_json::json!({
        "apiBaseUrl": api,
        "webBaseUrl": web,
        "gatewayBaseUrl": gateway,
    }))
}

/// Port of `getBakedBuildConfig` (`rayu/src/core/buildConfig.ts:201`).
///
/// Neither `RAYU_BAKED_BUILD_CONFIG` nor `globalThis.MACRO` exists in the
/// recording, so the value is `undefined` — the same marker JS callers see.
pub fn get_baked_build_config() -> Result<serde_json::Value, String> {
    Ok(undefined())
}

/// Port of `buildFeatureTable` (`rayu/src/core/features.ts:66`).
pub fn build_feature_table(
    all_flags: Vec<String>,
    enabled: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    // A default parameter covers `undefined`, not `null`: `new Set(null)` is empty.
    let default_set = || {
        ENABLED_FEATURES
            .iter()
            .map(|flag| (*flag).to_string())
            .collect::<std::collections::HashSet<String>>()
    };
    let enabled_set = match enabled.as_ref() {
        None => default_set(),
        Some(value) if is_undefined(value) => default_set(),
        Some(serde_json::Value::Null) => std::collections::HashSet::new(),
        // `new Set(array)`; non-strings can never equal a string flag.
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        // `new Set("abc")` iterates code points.
        Some(serde_json::Value::String(text)) => text.chars().map(|c| c.to_string()).collect(),
        Some(other) => return Err(format!("{} is not iterable", js_type_name(other))),
    };

    // JS object keys: array-index keys first, ascending; then the rest in
    // insertion order. `__proto__` assignment is ignored by a plain object.
    let mut numeric: BTreeMap<u32, bool> = BTreeMap::new();
    let mut named: Vec<(String, bool)> = Vec::new();
    let mut named_index: HashMap<String, usize> = HashMap::new();
    for flag in all_flags {
        if flag == "__proto__" {
            continue;
        }
        let on = enabled_set.contains(&flag);
        if let Some(index) = array_index(&flag) {
            numeric.insert(index, on);
        } else if let Some(&position) = named_index.get(&flag) {
            named[position].1 = on;
        } else {
            named_index.insert(flag.clone(), named.len());
            named.push((flag, on));
        }
    }

    let mut table = serde_json::Map::with_capacity(numeric.len() + named.len());
    for (index, on) in numeric {
        table.insert(index.to_string(), serde_json::Value::Bool(on));
    }
    for (flag, on) in named {
        table.insert(flag, serde_json::Value::Bool(on));
    }
    Ok(serde_json::Value::Object(table))
}

/// Port of `installFeatureTable` (`rayu/src/core/features.ts:85`).
///
/// The only observable effect is the `undefined` return: the flag table exists
/// to satisfy the bundler's dead-code elimination, which Cargo replaces with
/// compile-time features. The Rust app never reads `globalThis`.
pub fn install_feature_table(_table: serde_json::Value) -> Result<(), String> {
    Ok(())
}

fn json_string(text: &str) -> serde_json::Value {
    serde_json::Value::String(text.to_string())
}

/// JS property read `value[key]` with the TypeError it throws on a nullish base.
fn prop(value: &serde_json::Value, key: &str) -> Result<serde_json::Value, String> {
    match value {
        serde_json::Value::Null => Err(format!("Cannot read properties of null (reading '{key}')")),
        other if is_undefined(other) => Err(format!(
            "Cannot read properties of undefined (reading '{key}')"
        )),
        serde_json::Value::Object(map) => match map.get(key) {
            Some(found) if !is_undefined(found) => Ok(found.clone()),
            _ => Ok(undefined()),
        },
        // Property reads on primitives and arrays return `undefined` for these keys.
        _ => Ok(undefined()),
    }
}

fn first_nullish(first: serde_json::Value, second: serde_json::Value) -> Option<serde_json::Value> {
    if !is_nullish(&first) {
        Some(first)
    } else if !is_nullish(&second) {
        Some(second)
    } else {
        None
    }
}

fn is_nullish(value: &serde_json::Value) -> bool {
    value.is_null() || is_undefined(value)
}

/// `baked?.RAYU_...`: a nullish base yields undefined; a primitive yields undefined.
fn baked_value(baked: Option<&serde_json::Value>, key: &str) -> Result<serde_json::Value, String> {
    match baked {
        None => Ok(undefined()),
        Some(value) if is_nullish(value) => Ok(undefined()),
        Some(serde_json::Value::Object(map)) => match map.get(key) {
            Some(found) if !is_undefined(found) => Ok(found.clone()),
            _ => Ok(undefined()),
        },
        Some(_) => Ok(undefined()),
    }
}

/// `env.KEY || baked?.KEY || fallback`, then one trailing slash stripped.
fn resolve_endpoint(
    env_value: serde_json::Value,
    baked: serde_json::Value,
    fallback: &str,
) -> Result<String, String> {
    let chosen = if !is_falsy(&env_value) {
        env_value
    } else if !is_falsy(&baked) {
        baked
    } else {
        json_string(fallback)
    };
    match chosen {
        serde_json::Value::String(text) => Ok(strip_trailing_slash(&text)),
        _ => Err("url.replace is not a function".to_string()),
    }
}

/// JS `!value`: undefined, null, false, 0, -0, NaN and "" are falsy.
fn is_falsy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Bool(flag) => !flag,
        serde_json::Value::Number(number) => {
            number.as_f64().is_some_and(|f| f == 0.0 || f.is_nan())
        }
        serde_json::Value::String(text) => text.is_empty(),
        serde_json::Value::Array(_) => false,
        serde_json::Value::Object(map) => match map.get("$num").and_then(|v| v.as_str()) {
            // `$num` is how the bindings carry numbers JSON cannot express.
            Some("NaN") => true,
            Some(_) => false,
            // Any other object is truthy, except the transport's `undefined` marker.
            None => is_undefined(value),
        },
    }
}

/// `url.replace(/\/$/, '')`: one trailing slash, including one that sits before
/// a final line terminator (JS `$` also matches there).
fn strip_trailing_slash(url: &str) -> String {
    let chars: Vec<char> = url.chars().collect();
    let len = chars.len();
    if chars.last() == Some(&'/') {
        return chars[..len - 1].iter().collect();
    }
    let terminator_start = match chars.last() {
        Some('\n') if len >= 2 && chars[len - 2] == '\r' => Some(len - 2),
        Some('\n' | '\r' | '\u{2028}' | '\u{2029}') => Some(len - 1),
        _ => None,
    };
    if let Some(index) = terminator_start
        && index > 0
        && chars[index - 1] == '/'
    {
        let mut out: String = chars[..index - 1].iter().collect();
        out.extend(&chars[index..]);
        return out;
    }
    url.to_string()
}

/// A canonical JS array index: "0" or digits with no leading zero, below 2^32-1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() {
        return None;
    }
    if key == "0" {
        return Some(0);
    }
    if key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// The JS `typeof` name, for the `new Set(x)` TypeError text.
fn js_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => "object",
    }
}

/// JS `String.prototype.toLowerCase` (per-character mapping + Final_Sigma).
fn js_to_lowercase(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == '\u{03a3}' {
            let prev_cased = i > 0 && is_cased(chars[i - 1]);
            let next_cased = chars.get(i + 1).is_some_and(|&next| is_cased(next));
            out.push(if prev_cased && !next_cased {
                '\u{03c2}'
            } else {
                '\u{03c3}'
            });
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out
}

fn is_cased(c: char) -> bool {
    c.is_lowercase() || c.is_uppercase()
}

/// JS `String.prototype.trim`: WhiteSpace + LineTerminator, excluding U+0085 and
/// including U+FEFF, which `char::is_whitespace` gets the other way round.
fn js_trim(text: &str) -> String {
    text.trim_matches(is_js_whitespace).to_string()
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_truthy_is_an_allowlist() {
        assert!(is_env_truthy(serde_json::json!("true")).unwrap());
        assert!(is_env_truthy(serde_json::json!(" ON ")).unwrap());
        assert!(!is_env_truthy(serde_json::json!("0")).unwrap());
        assert!(!is_env_truthy(serde_json::json!("off")).unwrap());
        assert!(!is_env_truthy(serde_json::json!(0)).unwrap());
        assert!(is_env_truthy(serde_json::json!(1)).is_err());
    }

    #[test]
    fn js_trim_matches_js_whitespace_set() {
        assert_eq!(js_trim("\u{feff}true\u{3000}"), "true");
        assert_eq!(js_trim("\u{0085}true"), "\u{0085}true");
    }

    #[test]
    fn build_config_layers_differ_on_empty_string() {
        let env = serde_json::json!({ "RAYU_BUILD_WEB_URL": "" });
        let built = resolve_build_config(env, "1.0.0".to_string()).unwrap();
        assert_eq!(built["RAYU_WEB_URL"], "");
        let endpoints = resolve_endpoints(
            serde_json::json!({}),
            Some(serde_json::json!({ "RAYU_WEB_URL": "" })),
        )
        .unwrap();
        assert_eq!(endpoints["webBaseUrl"], "http://localhost:3000");
    }

    #[test]
    fn null_env_throws_the_js_message() {
        let err = resolve_build_config(serde_json::Value::Null, "x".to_string()).unwrap_err();
        assert_eq!(
            err,
            "Cannot read properties of null (reading 'RAYU_BUILD_OAUTH')"
        );
    }

    #[test]
    fn feature_table_orders_numeric_keys_first() {
        let table = build_feature_table(
            vec!["b".to_string(), "10".to_string(), "a".to_string()],
            Some(serde_json::json!(["10"])),
        )
        .unwrap();
        let keys: Vec<&String> = table.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["10", "b", "a"]);
        assert_eq!(table["10"], true);
    }
}
