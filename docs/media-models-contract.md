# Media model catalog contract (image / video generation)

The CLI holds **no** image- or video-generation model registry. It discovers them
at runtime from the Rayu provider, so adding a model is a backend catalog row and
nothing else — no CLI release.

```
rayu-backend  media_models table (admin-owned, seeded on first boot)
      │  (read by the gateway's config refresh, snapshotted in memory)
      ▼
rayu-gateway  GET /v1/models?media=image|video|all      Bearer <Rayu JWT>
      │  (plan-filtered per caller)
      ▼
rayu (CLI)    src/services/rayuAuth/mediaModels.ts      5-minute TTL cache
      │
      ├── src/tools/ImageGenTool/models.ts   family → request-body builder
      └── src/tools/VideoGenTool/models.ts   family → request-body builder
```

## Endpoint

`GET {RAYU_GATEWAY_URL}/v1/models` — the existing chat-model endpoint, with a new
`media` query parameter:

| `media` | Returns |
|---------|---------|
| *(absent)* | Hosted **chat** models (`hosted_models`). Unchanged behaviour. |
| `image` | Image-generation models |
| `video` | Video-generation models |
| `all` | Both, each item tagged with `mediaType` |
| anything else | `400` with an actionable message |

Auth: `Authorization: Bearer <Rayu access token>` (same as `/v1/credits`). The
response is filtered to the caller's plan and to `enabled` rows.

The two catalogs are never mixed in one response. A chat client must not be handed
`flux`/`veo` models (they are not routable through the gateway), and the image tool
must not have to filter a chat list.

## Response

```jsonc
{
  "object": "list",
  "media": "all",
  "data": [
    {
      "id": "black-forest-labs/flux.1-schnell",   // exact upstream model id
      "object": "model",
      "created": 1700000000,
      "owned_by": "rayu",
      "label": "FLUX.1 Schnell",
      "mediaType": "image",                        // "image" | "video"
      "capabilities": ["generate"],                // image: generate | edit
      "backend": "nvidia",                         // nvidia | vertex | nvcf | nvidia-svd | fal
      "family": "flux",                            // picks the CLI's body builder
      "defaultParams": { "cfg_scale": 0, "steps": 4 },
      "nvcfFunctionId": null,
      "estimatedSeconds": null,
      "default": true                              // preferred for its (mediaType, backend)
    },
    {
      "id": "nvidia/cosmos-predict1-5b",
      "object": "model",
      "created": 1700000000,
      "owned_by": "rayu",
      "label": "Cosmos Predict1 5B",
      "mediaType": "video",
      "capabilities": ["text2video", "image2video"], // one model can serve both
      "backend": "nvcf",
      "family": "cosmos-predict1",
      "defaultParams": null,
      "nvcfFunctionId": "eef816a3-3940-413b-93c9-513ae29f34f9",
      "estimatedSeconds": 120,                       // drives the CLI wait message
      "default": true
    }
  ]
}
```

### Field notes

- **`capabilities` is an array.** Some models genuinely do both — cosmos-predict1-5b
  takes an *optional* input image — and the CLI must be able to offer one model for
  both operations without a code change.
- **`defaultParams`** is what lets two models share one `family`: flux.1-schnell is
  guidance-distilled (`cfg_scale: 0`, 4 steps) while flux.1-dev needs
  `cfg_scale: 3.5` and 50 steps. Same request shape, different numbers, one builder.
- **`family`** is the only thing that can require a CLI change. A new model that
  reuses a known shape needs nothing client-side; a genuinely new shape needs a new
  entry in `IMAGE_BODY_BUILDERS` / `VIDEO_BODY_BUILDERS`. Until then the CLI fails
  with an error naming the family (`… uses request family "X", which this version of
  Rayu does not know how to build`) rather than crashing or sending a wrong body.
- **`default`** is resolved per `(mediaType, backend)` and per capability. Each CLI
  client resolves only among the backends it can actually POST to, in credential
  order — the NVIDIA image client among `nvidia`, the NVIDIA/fal video client among
  `nvcf`/`nvidia-svd`/`fal` (never `vertex`, which goes through the Vertex client).
  So a catalog whose default video model is Veo can never mis-route, and a fal-only
  user is never handed an NVIDIA default.
  Order the CLI applies: the model the user named → the env override
  (`NVIDIA_IMAGE_MODEL`, `NVIDIA_VIDEO_MODEL`, …) → the `default` model of the
  most-preferred servable backend → that backend's first model in `sortOrder`.
  The env override is looked up **within** the servable set, so pinning a model the
  client cannot serve is ignored rather than mis-routed.
  A named model that is **not in the catalog is an error**, never a silent
  substitution; a named model that *is* in the catalog but cannot do the requested
  operation *does* fall through to the default (that is how `input_image` routes a
  generate-only model to the editing model).
- **The tools route on the selected model's own `backend`**, not on which
  credentials happen to be present. Deciding from availability alone would send an
  explicitly requested NVIDIA model to Vertex on a Vertex-only machine, silently
  generating with a different model; routed this way the user gets an actionable
  "NVIDIA API key not configured" instead.
- A model remembered from `/model_image_generation` / `/model_video_generation` is
  **dropped** when it is no longer in the catalog, so a choice made weeks ago
  cannot fail every later generation — the same rule the chat model picker applies
  to a removed hosted model. Hand-written `imagen-*` / `veo-*` ids are kept, since
  the Vertex clients honour them verbatim.
- **Unknown extra fields are ignored** (forward compatible). An item missing any
  field the CLI needs is **dropped and counted**, and the CLI logs a loud error
  (once per distinct message, re-armed by the next clean fetch) so a short model
  list is explainable rather than mysterious.
- **An empty `data` is authoritative.** An admin who disabled every media model has
  disabled the feature; the CLI caches the empty catalog rather than reverting to
  its built-ins.
- **A gateway too old to know `?media=`** ignores the parameter and answers `200`
  with the *chat* catalog. The CLI detects that shape (models with no `mediaType`),
  reports "upgrade rayu-gateway", and does **not** cache it as an empty media
  catalog.

## Where the request body is built

Body building stays in the CLI, keyed by `family`. Media generation is **not**
proxied by the gateway: the CLI calls NVIDIA / Vertex / fal directly with the
user's own key (`NVIDIA_API_KEY`, `FAL_KEY`, GCP ADC). Moving body construction
server-side would mean proxying image/video traffic the gateway holds no key for.

The catalog therefore carries **no credential and no gateway-followed URL** — it is
metadata only.

## Caching and refresh

- In-memory + persisted to `~/.rayu/rayu-media-models.json` (mode 0600), bound to
  the signed-in user id so a plan-filtered catalog cannot leak across accounts.
- TTL 5 minutes; attempts are floored at 30s apart so an unreachable gateway cannot
  be hammered.
- The tools fetch lazily on **first invocation** (`ensureMediaModels()`), never at
  import time, so CLI startup does not wait on the gateway.
- `/model_image_generation` and `/model_video_generation` force a refresh when the
  picker opens, so a model added moments ago appears immediately.
- `/logout` clears the cache.

## Offline / direct-key mode

When `USE_RAYU_OAUTH=false` or the user is not signed in there is no gateway to
ask. The CLI then uses a built-in list
(`src/services/rayuAuth/mediaModelsFallback.ts`), tagged `source: 'fallback'` and
surfaced as such in the picker.

That list is **frozen at the exact set the CLI shipped before catalog discovery
existed**, and it mirrors the backend seed one-for-one (a test asserts both). The
reason is the plan's own risk item: media generation in this mode runs entirely on
the user's own key and never touches Rayu infrastructure, so a direct-key user must
not lose a single model they could use before. Shipping a *smaller* fallback would
have been exactly that regression.

It is **not** the source of truth and **must not grow**: a reachable gateway
catalog replaces it wholesale, nothing is merged, and new models belong in the
backend seed. A test pins its contents so an accidental addition fails CI.

## Adding a model (no CLI release)

1. `POST /api/admin/media-models` (admin/superadmin) with `code`, `label`,
   `mediaType`, `capabilities`, `backend`, `family`, and optionally
   `nvcfFunctionId`, `estimatedSeconds`, `defaultParams`, `allowedPlanCodes`
   (empty = every plan), `isDefault`, `sortOrder`.
   `PATCH`/`DELETE /api/admin/media-models/:code` — **URL-encode the code**, since
   upstream ids contain slashes (`black-forest-labs%2Fflux.1-schnell`).

   Validated on write, because each of these would create a row no client can use:
   - `capabilities` must suit the `mediaType` (`generate`/`edit` for image,
     `text2video`/`image2video` for video);
   - `backend` must serve that `mediaType` (image → `nvidia`/`vertex`; video →
     `nvcf`/`nvidia-svd`/`fal`/`vertex`);
   - `family` must be one the CLI has a request builder for.
   Changing `mediaType` re-validates both `capabilities` and `backend`, so a row
   cannot be left in an impossible combination. Boot logs also warn about a
   duplicate `isDefault` for the same `(mediaType, backend, capability)` — the CLI
   would then pick by `sortOrder`, so leave exactly one.
2. The gateway picks it up on its next config refresh (or immediately via
   `POST /v1/_reload`).
3. The CLI shows it within the 5-minute TTL, or immediately when the model picker
   is opened.

The shipped defaults live in
`rayu-backend/src/media-models/media-models.constants.ts` and seed **only when the
table is empty** (or when `SEED_CATALOG=true`), so a model an admin removed stays
removed across restarts.
