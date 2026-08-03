//! `GET /v1/models` -- the caller's plan-allowed catalog in OpenAI list shape.
//!
//! Port of `handleModels` / `writeMediaModels` from the Go gateway's
//! `internal/server/server.go`.
//!
//! The `media` query parameter selects WHICH catalog is returned:
//!
//! ```text
//! (absent)      -> hosted CHAT models (hosted_models)
//! media=image   -> image-generation models (media_models, mediaType=image)
//! media=video   -> video-generation models (media_models, mediaType=video)
//! media=all     -> every media model, image and video
//! ```
//!
//! The two catalogs are deliberately never mixed in one response: a chat client
//! asking for models must not be handed flux/veo (they are not routable through this
//! gateway), and the CLI's image tool must not have to filter a chat list.
//!
//! Media items carry the metadata the CLI needs to build an upstream request with
//! nothing hardcoded: capabilities, backend, request-shape family, per-model request
//! defaults, the NVCF function id, and an estimated duration. Media generation itself
//! is NOT proxied here -- the CLI calls the upstream with the user's own key -- so
//! this endpoint is a catalog, not a route.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::Response;
use axum::Extension;
use http::StatusCode;
use rayu_core::httpx;
use rayu_core::jwt::Claims;
use rayu_core::store::MediaModel;
use serde_json::{json, Value};

use crate::entitlements::{allowed_media_models, Entitlement};
use crate::state::{entitlement_error_response, status_or_unknown, AppState};

/// A fixed `created` timestamp: the OpenAI list shape requires the field, but a
/// hosted model has no meaningful creation time and a changing value would defeat
/// client-side caching.
const CREATED: i64 = 1_700_000_000;

pub async fn handle_models(
    State(st): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let ent = match st.ent.resolve(claims.user_id).await {
        Ok(e) => e,
        Err(e) => return entitlement_error_response(&e),
    };
    if !ent.active() {
        return httpx::write_error(
            StatusCode::FORBIDDEN,
            &format!("account is {}", status_or_unknown(&ent.status)),
        );
    }

    match q.get("media").map(String::as_str).unwrap_or("") {
        // Chat catalog (the default) -- behaviour predates the media catalog.
        "" => write_chat_models(&ent),
        media @ ("image" | "video" | "all") => {
            write_media_models(&st.ent.media_models(), &ent, media)
        }
        _ => httpx::write_error(
            StatusCode::BAD_REQUEST,
            "unknown media filter: use media=image, media=video, media=all, or omit it for chat models",
        ),
    }
}

fn write_chat_models(ent: &Entitlement) -> Response {
    let data: Vec<Value> = ent
        .allowed_models
        .iter()
        .map(|m| {
            json!({
                "id": m.code,
                "object": "model",
                "created": CREATED,
                "owned_by": "rayu",
                "label": m.label,
                // Capabilities so the client can warn the user ("this model can't
                // read images -- pick another model") instead of discovering it as an
                // error mid-request. Authoritative per model; enforced on the request
                // path.
                "supportsReasoning": m.supports_reasoning,
                "supportsImage": m.supports_image,
                "supportsTools": m.supports_tools,
                // Admin-set context window in tokens (null when unset, so the client
                // keeps its own default). Clients budget auto-compaction against it.
                "contextWindow": m.context_window,
            })
        })
        .collect();
    httpx::write_json(StatusCode::OK, &json!({"object": "list", "data": data}))
}

/// Answers the media variants of `/v1/models`.
///
/// The response keeps the same `{object:"list", data:[...]}` envelope as the chat
/// catalog so one client parser handles both, and adds `mediaType` so a `media=all`
/// caller can split the list without a second request.
fn write_media_models(catalog: &[MediaModel], ent: &Entitlement, media_type: &str) -> Response {
    // "all" means no filter at all, not a literal mediaType of "all".
    let filter = if media_type == "all" { "" } else { media_type };
    let models = allowed_media_models(catalog, &ent.plan.code, filter);

    let data: Vec<Value> = models
        .iter()
        .map(|m| {
            json!({
                "id": m.code,
                "object": "model",
                "created": CREATED,
                "owned_by": "rayu",
                "label": m.label,
                "mediaType": m.media_type,
                // Never null: an absent/corrupt column decodes to an empty list, and
                // the client treats a model with no capabilities as unusable rather
                // than crashing on a null.
                "capabilities": m.capabilities,
                "backend": m.backend,
                "family": m.family,
                // Per-model upstream request defaults, verbatim as the admin set
                // them. This is what lets two models share one request-shape family.
                "defaultParams": raw_or_null(m.default_params.as_ref()),
                "nvcfFunctionId": empty_to_null(&m.nvcf_function_id),
                "estimatedSeconds": m.estimated_seconds,
                "default": m.is_default,
            })
        })
        .collect();

    httpx::write_json(
        StatusCode::OK,
        &json!({
            "object": "list",
            "data": data,
            // Echo the filter so a client can tell a genuinely empty catalog from a
            // response it mis-addressed.
            "media": media_type,
        }),
    )
}

/// Renders an unset optional string as JSON null instead of `""`.
fn empty_to_null(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        Value::String(s.to_string())
    }
}

/// Passes the stored request defaults through untouched, or null when there are
/// none.
///
/// The gateway has no business interpreting upstream request params -- it carries
/// exactly what the admin set, which is what lets a new model reuse a known
/// request-shape family with no client release.
fn raw_or_null(raw: Option<&Value>) -> Value {
    match raw {
        None | Some(Value::Null) => Value::Null,
        Some(v) => v.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stored_request_defaults_pass_through_untouched() {
        assert_eq!(raw_or_null(None), Value::Null);
        assert_eq!(raw_or_null(Some(&Value::Null)), Value::Null);
        let params = json!({"steps": 30, "cfg": 7.5});
        assert_eq!(
            raw_or_null(Some(&params)),
            params,
            "stored defaults must reach the client verbatim, not re-serialized"
        );
    }

    #[test]
    fn empty_optional_strings_become_null() {
        assert_eq!(empty_to_null(""), Value::Null);
        assert_eq!(empty_to_null("fn-123"), Value::String("fn-123".into()));
    }
}
