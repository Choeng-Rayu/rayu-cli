# Fetch Image/Video Generation Models from the Rayu Provider (No Hardcoding)

## Improved Prompt

As a senior software engineer, eliminate the hardcoded image- and video-generation model registries in the RAYU CLI and replace them with **runtime discovery from the Rayu provider** (rayu-gateway / rayu-backend). The CLI must fetch the list of available image-generation models and video-generation models from the gateway/backend at runtime, and only those returned models are offered to the user.

## Current State (verified by reading the code)

The model registries are currently **fully hardcoded** in the CLI:

- `src/tools/ImageGenTool/models.ts` — `IMAGE_MODELS` is a static `Record<string, ImageModel>` with hardcoded entries: `black-forest-labs/flux.1-schnell`, `flux.1-dev`, `stabilityai/stable-diffusion-3.5-large`, `flux.1-kontext-dev`, and the Vertex `imagen-*` family. Each entry also hardcodes a `buildBody` function (NVCF/Vertex/flux/sd body shapes), a `provider` tag (`nvidia` | `vertex`), and a `capability` (`generate` | `edit`). Defaults come from `NVIDIA_IMAGE_MODEL` / `NVIDIA_EDIT_MODEL` env vars (still hardcoded fallbacks).
- `src/tools/VideoGenTool/models.ts` — `VIDEO_MODELS` is a static `Record<string, VideoModel>` with hardcoded entries: `nvidia/cosmos-predict1-5b`, `cosmos-transfer1-7b`, `cosmos3-nano`, `cosmos-1.0-7b-diffusion-text2world`, `stabilityai/stable-video-diffusion`, the `fal-ai/kling-video/*` pair, and the Vertex `veo-*` family. Each entry hardcodes `backend` (`nvcf` | `nvidia-svd` | `fal` | `vertex`), `capability` (`text2video` | `image2video`), `nvcfFunctionId` UUIDs, `estimatedSeconds`, and a `buildBody` function. Defaults come from `NVIDIA_VIDEO_MODEL` / `NVIDIA_IMAGE2VIDEO_MODEL`.

The gateway already exposes a `/v1/models` endpoint (`rayu-gateway/internal/server/server.go`: `pr.Get("/v1/models", s.handleModels)`) and the backend maintains a models catalog with capability flags (`rayu-backend/src/models/models.constants.ts`, including image capability flags, and `rayu-backend/src/auth/auth.controller.ts` exposes capabilities to the CLI). So a discovery feed for image/video-capable models already has an existing surface to build on — do NOT invent a new endpoint without first verifying what `/v1/models` and the backend's models module already return.

## CRITICAL RULES (per RAYU.md / AGENTS.md)

### Rule 1: NO ASSUMPTIONS — Read the Code First
Do NOT assume what `/v1/models` returns, what fields the backend models catalog stores, or what the existing `rayuAuth`/`rayu-gateway` client helpers look like. Before writing anything:
- ✅ READ `rayu-gateway/internal/server/server.go` `handleModels` and whatever it calls (`providercfg`, `store`, `entitlements`) to learn the exact response shape, filtering, and auth requirements.
- ✅ READ `rayu-backend/src/models/` (`models.service.ts`, `models.constants.ts`, any controller/module) to learn what model metadata already exists (capabilities, provider, build-body hints, function IDs, estimated seconds, etc.).
- ✅ READ `src/services/rayuAuth/rayuEntitlements.ts`, `rayuHostedProvider.ts`, `rayuSession.ts`, `rayuPlansCatalog.ts` — these already talk to the gateway; reuse the same auth + base URL + fetch helpers.
- ✅ READ `src/tools/ImageGenTool/ImageGenTool.ts` and `src/tools/VideoGenTool/VideoGenTool.ts` to see exactly how `IMAGE_MODELS` / `VIDEO_MODELS` and `resolveModel` / `resolveVideoModel` are consumed (so the new dynamic shape stays compatible).
- ✅ READ `src/tools/ImageGenTool/nvidiaImageClient.ts`, `vertexImageClient.ts`, `nvidiaVideoClient.ts`, `vertexVideoClient.ts` — these own the per-backend request shape. Decide whether build-body logic stays in the CLI (keyed by a `backend` / `provider` field returned from the gateway) or moves server-side.
- ✅ Check `ORIGIN_MANIFEST.md` for provenance of the files you touch.
- ❌ DON'T guess the response schema. Fetch a real sample (or read the handler) and lock the CLI's parser to it.
- ❌ DON'T assume all current hardcoded fields (e.g. `nvcfFunctionId`, `estimatedSeconds`) exist server-side. If they don't, flag the gap and propose the minimal backend/gateway addition — do not paper over by keeping hardcoded fallbacks.

### Rule 2: Search Before Writing
- Grep for existing model-list fetchers in the CLI (`src/services/rayuAuth/`, `src/services/api/`) — there may already be a `/v1/models` client to reuse.
- Grep for `IMAGE_MODELS`, `VIDEO_MODELS`, `resolveModel`, `resolveVideoModel`, `DEFAULT_IMAGE_MODEL`, `DEFAULT_VIDEO_MODEL` usages across the codebase to enumerate every consumer the change must keep working.
- Check `src/skills/`, `src/commands/`, and any UI (`src/components/`) that lists models to make sure they switch to the dynamic source too.

### Rule 3: Follow Project Conventions
- TypeScript + Bun, ES modules, dynamic `import()` for lazy loading.
- Do NOT convert feature-gated `require()` to static `import` — `feature('FLAG')` is compile-time DCE.
- Cache the fetched model list with a TTL (reuse the existing entitlements/plans caching pattern in `src/services/rayuAuth/`) — do not hit the gateway on every tool call.
- When `USE_RAYU_OAUTH` is false (direct API-key mode, no gateway), fall back gracefully: either a tiny built-in default set (clearly marked as fallback, not the source of truth) or disable the tool with a clear error. Decide explicitly and document it.

## Goal

Replace the two hardcoded model registries (`IMAGE_MODELS`, `VIDEO_MODELS`) with a **runtime-fetched, cached registry** sourced from the Rayu provider, while keeping the per-backend request-building logic correct and the CLI's existing tool UX intact. After this change, adding a new image or video model should require **zero CLI code changes** — it's just a new entry in the gateway/backend catalog.

## Required Plan (write in detail)

### 1. Discovery & Audit (no code yet)
- Read `rayu-gateway/internal/server/server.go` `handleModels` and the full call graph behind it. Document the exact response schema, auth requirement (Bearer Rayu JWT), and whether it can filter by capability (image-generation, video-generation, generate-vs-edit, text2video-vs-image2video).
- Read `rayu-backend/src/models/` and the Prisma schema for the `Model` table. List which fields already exist (`code`, `provider`, capabilities, etc.) and which are **missing** vs. what the CLI currently hardcodes:
  - Image: `capability` (`generate` | `edit`), `provider` (`nvidia` | `vertex`), and the build-body family (`flux` | `sd` | `kontext` | `imagen`).
  - Video: `backend` (`nvcf` | `nvidia-svd` | `fal` | `vertex`), `capability` (`text2video` | `image2video`), `nvcfFunctionId` (UUID), `estimatedSeconds`, and the build-body family (`cosmos-predict1` | `cosmos-transfer1` | `cosmos3-nano` | `cosmos-legacy` | `svd` | `fal-kling` | `veo`).
- Decide the contract: what new fields (if any) the gateway's `/v1/models` (or a new `/v1/media/models` or `/v1/image-models` + `/v1/video-models` endpoint) must return so the CLI can render the full registry without hardcoding. Prefer extending the existing `/v1/models` response with capability + media-specific metadata over creating a brand-new endpoint — but justify the choice in the plan.
- Decide where build-body logic lives: keep per-backend `buildBody` functions in the CLI keyed by a `backend` / `family` string returned by the gateway (preferred — minimal change), or move body-building server-side (heavier, only if needed). The plan must state which and why.

### 2. Backend / Gateway Changes
- If the existing `/v1/models` response lacks media metadata, add the minimal fields needed: `mediaType` (`image` | `video` | null), `capability` (for image: `generate` | `edit`; for video: `text2video` | `image2video`), `backend`/`family` (the CLI uses this to pick the right `buildBody`), `nvcfFunctionId` (for NVCF-backed video), `estimatedSeconds` (video only, for the wait message), and `default` flags so the CLI knows which model to pick when the user doesn't specify one.
- Add the same fields to the backend's `Model` table / models constants if missing (Prisma migration + seed updates). Keep provider keys out of the DB (per RAYU.md they live only in gateway env) — the catalog is metadata only.
- Add a capability filter to `/v1/models` (query param, e.g. `?media=image` or `?capability=video.text2video`) so the CLI can fetch just the relevant subset without client-side filtering of a huge list.
- Document the response schema in the plan with a concrete JSON sample.

### 3. CLI Changes (file-by-file, DCE-safe)
- `src/services/rayuAuth/mediaModels.ts` (new) — fetch + TTL-cached client for image/video models from the gateway. Reuse the same fetch/auth/base-URL helpers as `rayuEntitlements.ts` / `rayuHostedProvider.ts`. Returns `{ imageModels, videoModels, defaults }`. Cache in memory with a short TTL (e.g. 5 minutes) and a hard refresh on explicit user action (`/refresh-models` or similar).
- `src/tools/ImageGenTool/models.ts` (refactor) — remove the static `IMAGE_MODELS` record. Keep the per-backend `buildBody` functions (`fluxBody`, `sdBody`, `kontextBody`, Vertex path) as a **family-keyed map** (`Record<family, buildBody>`), since these are request-shape logic, not catalog data. `resolveModel` now takes the fetched list + a requested id, picks the entry, and pairs it with the right `buildBody` by `family`. Keep `isVertexImageModel` working (now derived from the fetched entry's `provider`/`backend` field, not a hardcoded id check).
- `src/tools/VideoGenTool/models.ts` (refactor) — same treatment. Keep `cosmosPredict1Body`, `cosmosTransfer1Body`, `cosmos3NanoBody`, `cosmosLegacyText2World`, `svdBody`, `falKling*Body`, `veoBody` as a `family`-keyed map. `resolveVideoModel` uses the fetched list. `nvcfFunctionId` and `estimatedSeconds` come from the fetched entry, not from a hardcoded constant.
- `src/tools/ImageGenTool/ImageGenTool.ts` and `src/tools/VideoGenTool/VideoGenTool.ts` — lazy-load `mediaModels.ts` at first tool invocation (not at module import), so the gateway round-trip doesn't slow CLI startup or bloat the bundle. Handle offline/no-gateway gracefully (see Decision below).
- `src/tools/ImageGenTool/constants.ts` and `src/tools/VideoGenTool/constants.ts` — remove hardcoded default model IDs; replace with the `default` flags from the fetched catalog. Keep env vars (`NVIDIA_IMAGE_MODEL`, etc.) as **overrides only**, not the source of truth.
- Any UI (`src/components/` model pickers) and any slash command that lists models — switch them to read from `mediaModels.ts`.

### 4. Decision: Offline / Direct-API-Key Mode
State explicitly in the plan what happens when `USE_RAYU_OAUTH` is false (no gateway):
- **Option A:** Disable `ImageGen` and `VideoGen` tools with a clear message ("requires rayu-gateway model catalog").
- **Option B:** Ship a tiny built-in fallback list, clearly marked as fallback, that only contains the free NVIDIA models (no provider keys, since keys live in the gateway anyway — so direct-key users would still need their own NVIDIA key, which the existing clients already support via `NVIDIA_API_KEY`).
Pick one and justify. Prefer the option that does NOT reintroduce a hardcoded catalog as the source of truth.

### 5. Verification Plan
- `bun run typecheck`
- `bun run build` (verify no bundle bloat — the new `mediaModels.ts` must be lazy-loaded)
- `bun test` — add unit tests for the new `mediaModels.ts` fetch+cache (mock the gateway response) and for the refactored `resolveModel` / `resolveVideoModel` (feed them a fetched-style list and assert correct family → buildBody wiring).
- Manual: with a valid Rayu JWT, run the CLI and invoke `ImageGen` and `VideoGen`; confirm the model list comes from the gateway (network log) and that a generation succeeds end-to-end.
- Manual: add a new model entry in the backend catalog (no CLI change) → restart gateway → confirm the new model appears in the CLI without a code change.
- Manual: offline / no-gateway path — confirm the documented fallback behavior works.

### 6. Risks
- **Schema drift** — if the gateway response shape changes, the CLI breaks. Pin the parser to a versioned shape and fail loudly (not silently) on unknown fields.
- **Cache staleness** — a new model added server-side won't appear until the TTL expires. Provide a manual refresh (slash command) and a short TTL.
- **Build-body family mismatch** — if the gateway returns a `family`/`backend` the CLI doesn't have a `buildBody` for, the CLI must fail with a clear error naming the unknown family, not crash.
- **Direct-key regression** — existing direct-NVIDIA-key users must not lose functionality. Verify the offline path still works for them.
- **Migration order** — backend/gateway must ship the new `/v1/models` fields before the CLI removes its hardcoded registry. Sequence the PRs accordingly, or keep the hardcoded list as a hidden fallback for one release cycle.

## Acceptance Criteria

- [ ] No hardcoded `IMAGE_MODELS` / `VIDEO_MODELS` records remain as the source of truth; the active list is fetched from the gateway at runtime.
- [ ] Adding a new image or video model requires **zero CLI code changes** (only a backend/gateway catalog entry).
- [ ] `/v1/models` (or a documented new endpoint) returns media capability, family/backend, defaults, and (video) `nvcfFunctionId` + `estimatedSeconds`.
- [ ] `resolveModel` / `resolveVideoModel` work against the fetched list and correctly pick the per-backend `buildBody`.
- [ ] Fetched list is cached with a TTL and manually refreshable.
- [ ] Offline / direct-key mode behavior is documented and works as decided.
- [ ] `bun run typecheck`, `bun run build`, `bun test` all pass.
- [ ] New `mediaModels.ts` is lazy-loaded — no startup slowdown, no bundle bloat.
- [ ] Existing `ImageGen` / `VideoGen` tool UX (model selection, edit vs generate, text2video vs image2video) is preserved.