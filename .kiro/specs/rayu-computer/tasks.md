# Implementation Plan: Rayu Computer

## Overview

This plan converts the Rayu Computer design into incremental, test-driven coding tasks for a code-generation LLM. Each task builds on the previous ones and ends by wiring new code into the running system, so there is no orphaned or unintegrated code.

Implementation languages follow the design's resolved decisions (Key Design Decisions): the `rayu-orchestrator` is **Go** (new module at repo root: `rayu-orchestrator/cmd/orchestrator/main.go` + `rayu-orchestrator/internal/{api,build,sandbox,stream,deploy,routing,tenancy,store,config,obs}`), and the "Rayu Computer" panel is **TypeScript/React** in the existing `rayu-web` Next.js App Router project. The durable store is the existing **MySQL 8** behind a `Store` interface (`InMemoryStore` first, then `MySQLStore`); the edge proxy is **Traefik** behind a `RouteRegistrar` seam (Caddy-Admin fallback). The `rayu/` CLI is never modified — the only coupling is the runtime `Build_Addendum` prompt and the pinned `rayu-cli` baked into the Sandbox image.

Work proceeds in three integration phases, each ending with end-to-end wiring:
- **Phase 1 (generate + stream):** tasks 1–11 — orchestrator skeleton, state machine, progress/SSE, worker pool/quotas, sandbox + headless swarm, and a Phase 1 e2e path that goes `queued → building → build_succeeded`.
- **Phase 2 (deploy + route):** tasks 13–16 — manifest parsing, host-side image build + App_Container run + health check, wildcard subdomain routing, and a Phase 2 e2e path to `live`.
- **Phase 3 (tenancy + ops):** tasks 18–24 — service auth/rate-limit/authz, BYOK redaction, reaping/cleanup/GC, observability, MySQL store + reconciliation, the `rayu-web` panel, and full `deploy/` integration + e2e smoke.

Property-based tests (P1–P8 from the design's Correctness Properties) use `pgregory.net/rapid` (Go) and `fast-check` (panel), driven by deterministic `stream-json` NDJSON fixtures under `testdata/streams/`. Tasks marked `[Integration: …]` require a real Docker daemon and/or MySQL 8 and run under the `//go:build integration` tag.

> Task-generation instruction followed: *Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.*

## Tasks

- [x] 1. Orchestrator skeleton, configuration, and store foundation
  - [x] 1.1 Initialize the `rayu-orchestrator` Go module and package layout
    - Create `rayu-orchestrator/go.mod`, `cmd/orchestrator/main.go` with a minimal wiring skeleton (`config → store → http server`), and empty `internal/{api,build,sandbox,stream,deploy,routing,tenancy,store,config,obs}` packages with placeholder types
    - Add a `Makefile`/`go test` target and the `pgregory.net/rapid` + Docker SDK (`github.com/docker/docker/client`) + chi dependencies
    - _Requirements: 1.9_

  - [x] 1.2 Implement the environment configuration loader and validation
    - Implement `internal/config` to load and validate all orchestrator env keys (`BASE_DOMAIN`, `PLATFORM_HOST`, `DOCKER_HOST`, `BUILDS_DIR`, `PROXY_NETWORK`, `EGRESS_NETWORK`, `MAX_CONCURRENT_BUILDS`, `PER_USER_CONCURRENCY`, `PER_USER_DAILY`, `SANDBOX_IMAGE`, `SANDBOX_CPU`, `SANDBOX_MEM`, `SANDBOX_PIDS`, `BUILD_MODEL`, `BUILD_TIMEOUT`, `HEALTHCHECK_DEADLINE`, `DEPLOY_COALESCE_INTERVAL`, `APP_TTL`, `APP_IDLE_TTL`, `STORE_DSN`, `DNS_PROVIDER`, `SERVICE_AUTH_SECRET`, `RATE_LIMIT_RPS`, `SECRET_PATTERNS`)
    - Fail fast with a descriptive error when a required key is missing or malformed
    - _Requirements: 3.1, 5.6, 6.2, 7.5, 13.1, 14.4, 17.1, 17.3, 19.2_

  - [x]* 1.3 Write unit tests for configuration validation
    - Cover required-key-missing, bad-duration, and valid-load cases
    - _Requirements: 3.1, 17.1, 17.3_

  - [x] 1.4 Define the `Store` interface and `InMemoryStore` with gap-free sequence allocation
    - In `internal/store`, define the `Store` interface over `builds`, `build_events`, `routes` (create/get build, set status, set failure reason, set subdomain URL, `AppendEvent` returning the assigned `Seq`, read events ascending, route CRUD, owner-scoped queries for quotas/authz)
    - Implement `InMemoryStore`; `AppendEvent` allocates the next per-build `Sequence_Number` (starts at 1, monotonic, no gaps/dups) and appends atomically so an aborted append burns no number
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 16.1_

  - [x]* 1.5 Write unit tests for `InMemoryStore`
    - Cover append-then-read-ascending, sequence starts at 1, owner-scoped active/daily queries
    - _Requirements: 9.2, 9.4, 16.1_

  - [x] 1.6 Implement observability scaffolding
    - In `internal/obs`, add a structured logger that routes every entry through a pluggable redactor hook (identity no-op now; real `Redact` wired in task 19) and a Prometheus registry with the metric collectors declared but not yet recorded
    - _Requirements: 21.1, 21.2_

- [x] 2. Progress event model, sequence persistence, and stream-json mapping
  - [x] 2.1 Implement the `ProgressEvent` model and `Emitter` interface
    - In `internal/stream/event.go`, define `ProgressEvent{BuildID, Seq, Kind, Payload, Ts}` with the 10 allowed `kind` values, and an `Emitter` interface the build engine will depend on
    - Write tests for the `kind` enumeration and JSON shape first
    - _Requirements: 8.1, 8.8_

  - [x]* 2.2 Write property test P2 (gap-free, monotonic Sequence_Number) against `InMemoryStore`
    - **Property P2: Gap-free, monotonic per-build Sequence_Number** — for K events and any interleaving of concurrent `AppendEvent` calls, persisted seqs equal exactly `{1..K}` with no gaps/dups and read in insertion order are strictly increasing; an aborted append consumes no number
    - **Validates: Requirements 8.8, 9.1, 9.2, 9.3** — `rapid`, with a fault-injection variant
    - _Requirements: 8.8, 9.1, 9.2, 9.3_

  - [x] 2.3 Implement the stream-json → `ProgressEvent` mapper
    - In `internal/stream/mapper.go`, map each NDJSON line per the design table: `assistant`→`log`, tool invocation→`tool_use`, tool result→`tool_result`, Write/Edit on workspace path→`file_change` (workspace-relative path), phase markers / `.rayu/swarm/shared.json` / `<DOMAIN>.md` writes→`phase`, agent/`subagent_type` spawn→`agent`, `result`→`result`, stderr/non-zero→`error`, and any unparseable line→`log` (then continue)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x]* 2.4 Write golden unit tests for the mapper
    - Use `testdata/streams/*.ndjson` fixtures; assert each `kind`/payload including the unparseable-line→`log` fallback and `file_change` path extraction
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

- [x] 3. SSE hub — persist-before-deliver, replay, heartbeat
  - [x] 3.1 Implement `Hub.Emit` and the per-build subscriber registry
    - In `internal/stream/hub.go`, implement `Emit = redact-hook → assign seq + append to Store → fan-out to subscribers`, persisting before delivery; maintain an in-memory per-build subscriber set + live-tail channel
    - _Requirements: 8.8, 9.1_

  - [x] 3.2 Implement the SSE handler (replay → live, heartbeat, terminal close)
    - In `internal/stream/sse.go`, set `Content-Type: text/event-stream` and `id:`=seq; on `Last-Event-ID:N` replay persisted events with `seq>N` ascending then switch to live atomically; send a `:` heartbeat comment after 15s idle; on terminal status deliver the final event then close; for an already-terminal build replay all ascending then close
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x]* 3.3 Write property test P3 (SSE replay complete/ordered/gap-free/dup-free)
    - **Property P3: SSE replay is complete, ordered, gap-free, and duplicate-free** — for a log of M events and any N in `[0,M]`, `replay(N)` returns exactly seqs `(N,M]` ascending; `[1..N] ++ replay(N) == [1..M]`; `N=0` returns all; plus a concurrent replay→live-handoff variant that neither drops nor repeats the boundary event
    - **Validates: Requirements 9.4, 9.5, 10.3, 10.6** — `rapid`
    - _Requirements: 9.4, 9.5, 10.3, 10.6_

- [x] 4. Build lifecycle state machine
  - [x] 4.1 Implement the status type, transition table, and `Machine.Transition`
    - In `internal/build/machine.go`, implement `Status`, pure table-driven `CanTransition`/`IsTerminal`, and `Transition` that validates the edge, persists the new status, emits exactly one `status` event on success (before the next transition), emits one `log` event on a rejected edge (retaining status), and on `failed` records a reason + emits one `error` event; allow `live→terminated` only
    - Inject the `Emitter` (task 2.1) so the machine is testable with a fake emitter
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [x]* 4.2 Write the exhaustive 81-pair `CanTransition` table test
    - Assert all 9×9 ordered pairs against the spec edge set (proves the reference model used by P1)
    - _Requirements: 2.2_

  - [x]* 4.3 Write property test P1 (state-machine transition validity)
    - **Property P1: State-machine transition validity** — over random transition sequences from `queued`, persisted status is reachable via permitted edges, rejected edges leave status unchanged, terminals are sticky (`live` may only advance to `terminated`); each rejected attempt emits one `log`, each accepted one `status`, each `failed` one `error` with a reason
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5** — `rapid` stateful model over `InMemoryStore`
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [x] 5. HTTP API surface
  - [x] 5.1 Implement the chi router, middleware skeleton, and JSON/error helpers
    - In `internal/api`, build the router with `recover → request-log` middleware (auth/rate-limit/authz slots reserved for task 18), JSON encode/decode helpers, and the machine-readable `{error:{code,message}}` shape
    - _Requirements: 1.9_

  - [x] 5.2 Implement the build handlers
    - `POST /v1/builds` (validate non-empty prompt + `ownerId`; 400 on missing/empty with no record; 201 with `{buildId,status:queued,streamUrl,createdAt}`), `GET /v1/builds/{id}` (200 with status/timestamps + `subdomainUrl` only when `live`; 404 unknown), `POST /v1/builds/{id}/cancel` (202; 409 if terminal; 404 unknown), `DELETE /v1/builds/{id}` (200 + teardown hooks; 404 unknown)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.5_

  - [x] 5.3 Wire the SSE stream endpoint and stub `/healthz` + `/metrics`
    - Wire `GET /v1/builds/{id}/stream` to the SSE handler (task 3.2); add `GET /healthz` (200 stub now) and `GET /metrics` (Prometheus text from the registry); both exempt from the auth chain
    - _Requirements: 1.7, 1.8, 10.1, 15.3_

  - [x]* 5.4 Write handler unit tests
    - Cover 201 shape, 400 empty-prompt/no-owner, 404 unknown id, 409 cancel-when-terminal, `subdomainUrl` present only when `live`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 6. Worker pool, admission control, and quotas
  - [x] 6.1 Implement the worker pool and admission loop
    - In `internal/build/pool.go`, enforce the global `MAX_CONCURRENT_BUILDS` cap; when a slot frees, admit the longest-`queued` build whose owner is under `PER_USER_CONCURRENCY` and transition it `queued→provisioning`; emit a queue-position `status` event while queued
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x]* 6.2 Write property test P6 (admission ordering & bounds)
    - **Property P6: Admission ordering & bounds** — the admitted build is always the longest-queued whose owner is under `PER_USER_CONCURRENCY`; `building` count never exceeds `MAX_CONCURRENT_BUILDS`; a per-user-blocked build stays `queued`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4** — `rapid`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 6.3 Implement quota accounting
    - In `internal/build/quota.go`, implement `CheckOnCreate` enforcing per-user `Concurrency_Quota` (active builds) and `Daily_Quota` (trailing 24h), returning distinct quota-exceeded vs daily-quota-exceeded errors; decrement the active count exactly once when a build reaches a terminal status
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_

  - [x]* 6.4 Write property test P7 (quota accounting consistency)
    - **Property P7: Quota accounting consistency** — for all create/terminal interleavings, an owner's tracked active count equals their non-terminal builds, is never negative, and is decremented exactly once per terminal
    - **Validates: Requirements 17.1, 17.5** — `rapid`
    - _Requirements: 17.1, 17.5_

  - [x] 6.5 Create the build engine and wire pool + quota into create/lifecycle
    - Add `internal/build/engine.go` holding collaborators (store, machine, pool, hub) and a per-build owning goroutine driven by `context.Context` (cancel flips toward `canceled`); modify `POST /v1/builds` to run `CheckOnCreate` before admission, returning 429 with the correct error code on quota breach
    - _Requirements: 3.1, 17.2, 17.4, 22.6_

- [ ] 7. Checkpoint — Phase 1 core logic
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Sandbox image and entry script
  - [ ] 8.1 Author the `Sandbox_Image` Dockerfile
    - In `rayu-orchestrator/sandbox/Dockerfile`: `FROM node:22-bookworm-slim`, install `rayu-cli` at an exact pinned `ARG RAYU_CLI_VERSION` (build fails if not installable), create non-root `useradd -u 10001`, copy the Entry_Script as `ENTRYPOINT`, `USER 10001`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 8.2 Author the `Entry_Script`
    - In `rayu-orchestrator/sandbox/entrypoint.sh`: emit two stream-json USER messages (`/collaborator_swarm`, then `<prompt>\n\n<Build_Addendum>`); invoke `rayu --print --agent-teams --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions --model "$BUILD_MODEL"`; `tee /workspace/.rayu-stream.ndjson` and forward stdout one line at a time (no buffering beyond a line); read BYOK only from env/stream (never written to a file); on a `result` message report success/error subtype; proceed if only `--print` is absent
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7_

- [ ] 9. Hardened SandboxRunner
  - [ ] 9.1 Implement `SandboxRunner` run policy and lifecycle
    - In `internal/sandbox/runner.go`, map `RunSpec` to a Docker `HostConfig` encoding `CapDrop=["ALL"]`, `ReadonlyRootfs=true`, `Tmpfs{/tmp}`, `User="10001"`, `SecurityOpt=["no-new-privileges:true","seccomp=<profile>"]`, `PidsLimit`/`NanoCPUs`/`Memory`, `NetworkMode=EGRESS_NETWORK`, workspace bind mount, and `IS_SANDBOX=1` + BYOK env; implement `Start/Stream(demux stdout/stderr)/Wait(OOM→resource-exhaustion)/Stop/Cleanup`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.5, 6.8, 22.1, 22.2, 22.3, 22.7_

  - [ ]* 9.2 Write unit tests for the `RunSpec → HostConfig` mapping
    - Use a fake Docker client; assert every hardening field is set as specified
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 9.3 [Integration: Docker] Verify the run policy against a real daemon
    - Start a real container and `docker inspect` the hardening fields; a fork-bomb probe confirms the pids limit; an alloc probe confirms OOM-kill → `failed(resource_exhausted)`
    - _Requirements: 5.1, 5.6, 5.8, 22.1, 22.2_

- [ ] 10. Headless swarm invocation, workspace validation, and build timeout
  - [ ] 10.1 Implement the `Build_Addendum` text contract
    - In `internal/build/addendum.go`, define the prompt fragment instructing the swarm to emit a workspace-root `Dockerfile` and a `rayu-build.json` (`{name,type:node|static,port,healthCheckPath,env}`) with the app listening on `0.0.0.0:$PORT` (the only rayu-side coupling)
    - _Requirements: 6.4, 11.1_

  - [ ] 10.2 Implement the building-state path and build timeout
    - Extend `internal/build/engine.go`: on `provisioning→building` start the sandbox (task 9.1), pipe `Stream()` → mapper (task 2.3) → `Hub.Emit` (task 3.1), handle the reported `result` subtype (success/error), and enforce `BUILD_TIMEOUT` — on exceed, terminate the sandbox and transition `failed(timeout)`
    - _Requirements: 6.1, 6.7, 7.3, 7.5_

  - [ ] 10.3 Implement workspace validation
    - In `internal/build/validate.go`, after a success `result` verify the workspace contains a `Dockerfile` and a JSON-parseable `rayu-build.json`; on success transition `building→build_succeeded`, else `failed(missing_or_invalid_artifact)` (full manifest schema validation is deferred to task 13)
    - _Requirements: 7.1, 7.2, 7.4_

  - [ ]* 10.4 Write unit tests for result-subtype handling, validation, and timeout
    - Drive the engine with a fake runner + fixtures: error subtype → `failed`; missing Dockerfile/unparseable manifest → `failed`; elapsed > timeout → `failed(timeout)`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 11. Phase 1 end-to-end wiring
  - [ ] 11.1 Author deterministic fake-swarm fixtures and a fake Sandbox image
    - Add `testdata/streams/*.ndjson` (full success with every `kind`; generation error; unparseable line; BYOK-in-assistant-text) and a `test/fakeswarm/` image whose Entry_Script replays a fixture to stdout via the same tee→forward path and writes `Dockerfile` + `rayu-build.json` into `/workspace`
    - _Requirements: 6.6_

  - [ ] 11.2 Wire the Phase 1 path in `main.go`
    - Compose `config → store → docker client → hub → pool/quota → engine → api` in `cmd/orchestrator/main.go` so a real `POST /v1/builds` runs `queued → provisioning → building → build_succeeded` and streams events over SSE
    - _Requirements: 1.1, 2.4, 8.8, 10.1_

  - [ ]* 11.3 [Integration: Docker] Phase 1 e2e
    - Drive `POST` → observe SSE from `queued` through `build_succeeded` with the fake swarm; verify mid-stream drop + `Last-Event-ID` resume (no gap/dup) and already-terminal replay-then-close
    - _Requirements: 1.1, 8.1, 9.4, 10.3, 10.6_

- [ ] 12. Checkpoint — Phase 1 complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Build manifest parsing and canonicalization
  - [ ] 13.1 Implement `Manifest`, `ParseManifest`, and `Canonical`
    - In `internal/deploy/manifest.go`, parse `rayu-build.json`, validate it specifies application type + internal port + run command/entrypoint (invalid → typed validation error), and produce a stable canonical serialization (sorted keys)
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 13.2 Write property test P4 (manifest round-trip) and negative parse tests
    - **Property P4: Build_Manifest parse/serialize round-trip** — for all valid manifests `m`, `Parse(Canonical(m)) == m` and `Canonical(Parse(Canonical(m))) == Canonical(m)` (idempotent, key-order/whitespace independent)
    - **Validates: Requirements 11.4** — `rapid`; companion negatives assert missing type/port/run → validation error (Req 11.3)
    - _Requirements: 11.3, 11.4_

- [ ] 14. Deploy pipeline — image build, app run, health check
  - [ ] 14.1 Implement deploy-strategy selection gated on a validated manifest
    - In `internal/deploy/strategy.go`, select `static`→static-site strategy and `node`→Node service strategy; apply no strategy until the manifest is parsed + validated
    - _Requirements: 11.5, 11.6_

  - [ ] 14.2 Implement host-side image build with deploy events
    - In `internal/deploy/image.go`, `docker build` the workspace `Dockerfile` on the host; stream build log as `deploy` events; on failure transition `failed(image_build_failure)` + emit a `deploy` event describing it
    - _Requirements: 12.1, 12.2_

  - [ ] 14.3 Implement constrained `App_Container` run
    - In `internal/deploy/run.go`, run the built image with `NanoCPUs`/`Memory`/`PidsLimit`, `CapDrop=["ALL"]`, `no-new-privileges`, read-only rootfs + tmpfs, attached to an egress-restricted network denying link-local/metadata; emit a container-start `deploy` event and coalesce milestones within `DEPLOY_COALESCE_INTERVAL`
    - _Requirements: 12.3, 12.4, 12.5_

  - [ ] 14.4 Implement the health-check poll
    - In `internal/deploy/health.go`, poll `:<port><healthCheckPath>` until 200 or `HEALTHCHECK_DEADLINE`; success → `deploying→live` + a `deploy` event carrying the subdomain URL; deadline → stop the container + `failed(health_check_failure)`
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ]* 14.5 Write unit tests for strategy selection, coalescing, and health transitions
    - Use a fake Docker/HTTP client; cover static vs node selection, milestone coalescing, success/deadline branches
    - _Requirements: 11.5, 12.5, 13.2, 13.3_

  - [ ]* 14.6 [Integration: Docker] Verify the deploy pipeline against a real daemon
    - Build + run a tiny fixture workspace to `live`; a failing Dockerfile asserts `failed(image_build_failure)`; a never-healthy app asserts `failed(health_check_failure)`
    - _Requirements: 12.1, 12.2, 13.2, 13.3_

- [ ] 15. Reverse proxy and subdomain routing
  - [ ] 15.1 Implement `RouteRegistrar` with Traefik labels and Route_Record lifecycle
    - In `internal/routing/registrar.go`, define the interface and the Traefik implementation: `Labels(buildID,port)` returns the `traefik.enable`/`routers.<id>.rule=Host(...)`/`tls`/`certresolver=wildcard`/`services.<id>.loadbalancer.server.port` set; `Register`/`Deregister` write/delete the Route_Record (`build_id, subdomain, container_id, internal_port, last_access_at`)
    - _Requirements: 14.1, 14.2, 14.5_

  - [ ]* 15.2 Write unit tests for label generation and Route_Record lifecycle
    - Assert label contents for a build/port and Route_Record create/delete
    - _Requirements: 14.1, 14.5_

  - [ ] 15.3 Implement Base_Domain selection, per-app isolation, and label wiring
    - Add `internal/routing/domain.go` (prod wildcard `BASE_DOMAIN` vs dev `sslip.io`); modify `internal/deploy/run.go` to attach the registrar labels at `App_Container` create and place each app on a per-app/ICC-disabled network sharing only the `proxy` network with Traefik; unmapped host → 404 is the proxy default (no labeled container = no router)
    - _Requirements: 14.3, 14.4, 14.6, 14.7, 22.4_

  - [ ]* 15.4 [Integration: Docker + Traefik] Verify routing behavior
    - Assert a request to `https://<id>.<base>` reaches the app, an unmapped host returns 404, stopping the container auto-removes the route, and one App_Container cannot connect to another
    - _Requirements: 14.2, 14.6, 14.7, 22.4_

- [ ] 16. Phase 2 end-to-end wiring
  - [ ] 16.1 Wire deploy + routing into the build engine
    - Extend `internal/build/engine.go`: on `build_succeeded` run `deploying` (parse manifest → image build → app run → health check → `live`), create the Route_Record, persist `subdomain_url` while `live`, and deregister the route + stop the App_Container on cancel/delete/terminal
    - _Requirements: 1.3, 12.1, 13.2, 13.4, 14.5_

  - [ ]* 16.2 [Integration: Docker] Phase 2 e2e
    - With the fake swarm, drive a build through `deploying` to `live`, confirm the subdomain is reachable and the SSE stream carries `deploy` events and the final `live` status with `subdomainUrl`
    - _Requirements: 12.5, 13.4, 14.1_

- [ ] 17. Checkpoint — Phase 2 complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Service authentication, rate limiting, and per-user authorization
  - [ ] 18.1 Implement service-auth + rate-limit middleware
    - In `internal/api/auth.go`, validate `Authorization: Bearer <service-jwt>` (HMAC-SHA256 over `SERVICE_AUTH_SECRET`=`RAYU_JWT_SECRET`) on all `/v1/builds` routes → 401 with no side effects on failure; add a per-Caller token-bucket rate limit (`RATE_LIMIT_RPS`) → 429 `rate_limited`; wire both into the router chain leaving `/healthz` + `/metrics` exempt
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 22.6_

  - [ ] 18.2 Implement per-user authorization
    - In `internal/api/authz.go`, on `GET/stream/cancel/delete` compare request `ownerId` to `Build_Record.ownerId`; non-owner and non-existent both return 404 (never disclose existence); modify the handlers to enforce it
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ]* 18.3 Write unit tests for auth, rate limit, and authz
    - Cover 401 (no side effects), 429 (`rate_limited`), and 404 for both non-owner and non-existent builds
    - _Requirements: 15.2, 15.4, 16.3_

- [ ] 19. BYOK key vault and central redaction
  - [ ] 19.1 Implement the in-memory `KeyVault` and central `Redact`
    - In `internal/tenancy`, implement `KeyVault` (`Put/Get/Drop`, key set on create, dropped at terminal, never persisted to any store) and `Redact(buildID,s)` that removes the active BYOK key even with no pattern configured, removes any configured `SECRET_PATTERNS` match, and is idempotent
    - _Requirements: 18.1, 18.2, 18.4, 22.5_

  - [ ] 19.2 Wire `Redact` as the single choke point
    - Set the logger's redactor hook (task 1.6) to `Redact`; redact every `ProgressEvent.Payload` before persist/deliver in `internal/stream/event.go`; redact each stream-json line before mapping in `internal/stream/mapper.go`
    - _Requirements: 18.3, 18.5, 21.4_

  - [ ]* 19.3 Write property test P5 (BYOK redaction invariant) + choke-point assertion
    - **Property P5: BYOK redaction invariant** — for all strings `s` and active keys `k`, `k` is not a substring of `Redact(buildID,s)` (with or without configured patterns); configured patterns are removed; `Redact(Redact(s))==Redact(s)`
    - **Validates: Requirements 18.3, 18.5, 21.4, 22.5** — `rapid`; plus a call-graph/lint test that every write path (logger, event serializer, ProgressEvent emit, stream-json ingest) routes through `Redact`
    - _Requirements: 18.3, 18.5, 21.4, 22.5_

- [ ] 20. Idle reaping, cleanup, and orphan garbage collection
  - [ ] 20.1 Implement last-access recording and the Idle_Reaper loop
    - In `internal/build/reaper.go`, record/update `routes.last_access_at` from proxy access; periodically evaluate `live` builds and, when `now-last_access_at > APP_IDLE_TTL` or `now-created_at > APP_TTL`, stop the App_Container, deregister the route, and transition `live→terminated` with the reaping reason recorded
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [ ]* 20.2 Write property test P8 (last-access monotonicity)
    - **Property P8: Last-access monotonicity** — `last_access_at` is non-decreasing across access updates, and a build is reaped iff `now-last_access_at > APP_IDLE_TTL` or `now-created_at > APP_TTL`
    - **Validates: Requirements 19.1, 19.2, 19.3** — `rapid`
    - _Requirements: 19.1, 19.2, 19.3_

  - [ ] 20.3 Implement sandbox and workspace cleanup
    - In `internal/build/cleanup.go` (wired into `engine.go`): stop + remove the Sandbox when a build leaves `building` for any reason, and remove the bind-mounted workspace directory on terminal
    - _Requirements: 20.1, 20.2_

  - [ ] 20.4 Implement orphan garbage collection
    - In `internal/build/gc.go`, periodically reconcile Docker containers vs the Store; remove containers with no corresponding non-terminal Build_Record (never one that still has a non-terminal record); log removal with container id + reason and complete removal even if the log write fails
    - _Requirements: 20.3, 20.4_

  - [ ]* 20.5 [Integration: Docker] Verify cleanup and orphan GC
    - Assert sandbox removal on leaving `building`, workspace removal on terminal, orphan removal of a label-only container, and that a container with a live non-terminal record is preserved
    - _Requirements: 20.1, 20.2, 20.3_

- [ ] 21. Observability completion — metrics, logs, health
  - [ ] 21.1 Implement Prometheus metrics and record-on-terminal
    - Populate `internal/obs` collectors: `builds_total{terminal_status}` counter, `building` gauge, `live` gauge, `build_duration_seconds` histogram; record from the state machine's terminal path (recording duration on terminal; optionally on cancel/interrupt when meaningful)
    - _Requirements: 21.2, 21.3_

  - [ ] 21.2 Implement structured transition logs and real `/healthz`
    - Emit a structured log (build_id, event type, timestamp, routed through `Redact`) on each status transition, sandbox lifecycle event, and deploy step; make `GET /healthz` return 200 iff Store + Docker are reachable, else 503
    - _Requirements: 1.7, 21.1, 21.4_

  - [ ]* 21.3 Write unit tests for metrics, health, and log redaction
    - Assert counter/gauge/histogram updates on terminal, `/healthz` 200 vs 503, and that a configured secret is excluded from emitted log entries
    - _Requirements: 1.7, 21.2, 21.3, 21.4_

- [ ] 22. MySQL store and restart reconciliation
  - [ ] 22.1 Implement the MySQL schema and `MySQLStore`
    - Add `internal/store/schema.sql` (`builds` with `next_seq`, append-only `build_events` with PK `(build_id,seq)`, `routes`) and `internal/store/mysql.go` implementing the `Store` interface; allocate sequences with the `SELECT next_seq … FOR UPDATE` + insert + `next_seq=N+1` transaction so commit/rollback burns no number
    - _Requirements: 9.1, 9.2, 9.3, 16.1_

  - [ ]* 22.2 [Integration: MySQL] Run P2/P3 and append-only checks against `MySQLStore`
    - Execute the P2 (sequence) and P3 (replay) properties against real InnoDB `FOR UPDATE` semantics under parallel writers; assert no UPDATE/DELETE of events while non-terminal
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [ ] 22.3 Implement restart reconciliation and store selection
    - In `internal/build/reconcile.go`, on startup load all non-terminal builds, inspect Docker for each Sandbox/App_Container, and transition missing ones to `failed(reconciled_missing_runtime)`; wire `STORE_DSN` selection (memory:// vs MySQL) and the reconcile call in `main.go`
    - _Requirements: 2.7_

  - [ ]* 22.4 [Integration: Docker + MySQL] Verify reconciliation and GC end-to-end
    - Kill the process mid-build and assert non-terminal builds whose containers are gone become `failed`; leave a labeled container with no non-terminal record and assert orphan removal + log
    - _Requirements: 2.7, 20.3_

- [ ] 23. rayu-web "Rayu Computer" panel
  - [ ] 23.1 Implement prompt submission
    - Add the panel as a `rayu-web` App Router client component (`'use client'` line 1, `export const dynamic = 'force-dynamic'`) using `lib/config.ts` `apiUrl()` and the existing Clerk→Rayu exchange (`lib/useRayuToken.ts`): sign-in gate while unauthenticated (no submit), client-side non-empty/whitespace validation, `POST` to `NEXT_PUBLIC_RAYU_API_URL` with Bearer, 201 → live-progress view, 429 → quota message + retry, other errors → message + re-enable; never persist BYOK in browser storage (send only over the authenticated request)
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8_

  - [ ]* 23.2 Write component tests for submission
    - Cover Clerk gating, empty-prompt validation, 429 and generic-error handling, and that BYOK is never written to `localStorage`/`sessionStorage`/cookies (Jest)
    - _Requirements: 23.2, 23.4, 23.6, 23.7, 23.8_

  - [ ] 23.3 Implement the live-progress view and resume
    - Open SSE to `NEXT_PUBLIC_RAYU_GATEWAY_URL`; render by `kind` (phase/agent/tool_use/tool_result/file_change/log); update status on `status` events; retain the last rendered `seq`; on drop before terminal reconnect with `Last-Event-ID=lastSeq`; cancel control posts to backend; show a "still connected, awaiting progress" indicator when idle
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6, 24.7_

  - [ ]* 23.4 Write live-progress tests including the fast-check resume property
    - **Property P3 (client side): resume without gap or duplicate** — for a random drop point and `Last-Event-ID=lastRenderedSeq`, the rendered timeline equals the full event order with no gap/dup
    - **Validates: Requirements 24.5** — `fast-check`; plus render-by-kind, status update, and cancel tests
    - _Requirements: 24.2, 24.3, 24.5, 24.6_

  - [ ] 23.5 Implement completion and failure display
    - On `live` render `https://<id>.<base>` as an open-in-new-context control; on `failed` show the terminal `error` reason; on `canceled` indicate cancellation; on any terminal close the SSE and re-enable starting a new build; opening the panel for an already-terminal build requests the stream with no `Last-Event-ID`, renders the replay in seq order, and shows the terminal outcome
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

  - [ ]* 23.6 Write component tests for terminal displays
    - Cover live-link new-context, failure reason, canceled indication, terminal close + re-enable, and already-terminal replay
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5_

- [ ] 24. Deploy integration and full e2e smoke
  - [ ] 24.1 Update the `deploy/` stack
    - In `deploy/docker-compose.yml` add the `orchestrator` service (mount the Docker socket + `/srv/builds`, attach to `rayu`/`proxy`/`egress` networks), replace the `caddy` service with `traefik` (ports 80/443, Docker provider, DNS-01 wildcard resolver, static routers for `PLATFORM_HOST` `/api`→backend, `/gateway`→gateway, `/`→web), reuse the existing `mysql` with a new `orchestrator` schema (apply `schema.sql`), and add the new env keys to `deploy/.env.example`
    - _Requirements: 14.3, 14.4_

  - [ ]* 24.2 [Integration: Docker + MySQL] Full e2e smoke with the fake-swarm fixture
    - Exercise: happy path `queued→…→live` + subdomain reachable; mid-stream resume; already-terminal replay; sad paths (result error, missing artifact, build timeout, cancel); authz/tenancy (non-owner 404, unauthenticated 401, quota 429)
    - _Requirements: 1.1, 7.3, 7.4, 7.5, 10.3, 10.6, 13.2, 14.6, 15.2, 16.3, 17.2_

- [ ] 25. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test/integration tasks and can be skipped for a faster MVP; core implementation tasks are never optional. Per the workflow, write the referenced unit/property tests first (TDD) when implementing the parent task.
- `[Integration: Docker]` / `[Integration: MySQL]` / `[Integration: Docker + MySQL]` / `[Integration: Docker + Traefik]` tasks require the corresponding real runtime and run under the `//go:build integration` tag (skipped in the pure-unit lane).
- Each task references granular requirement sub-clauses for traceability; together the tasks cover Requirements 1–25.
- Property tests P1–P8 (design Correctness Properties) use `pgregory.net/rapid` (Go) and `fast-check` (panel), with pinned seeds and deterministic `testdata/streams/*.ndjson` fixtures; discovered counterexamples are committed as regression fixtures. P2 and P3 are additionally run against `MySQLStore` (task 22.2).
- Deferred non-goals stay out of scope: billing/metering/payments, horizontal scaling beyond one VPS (no external Redis/NATS queue), custom user domains, long-term project persistence/editing/resume, a full in-browser IDE, and the internal mechanics of `rayu-backend`/`rayu-gateway` beyond the integration contract.
- The `rayu/` CLI is not modified; the sole coupling is the runtime `Build_Addendum` (task 10.1) and the pinned `rayu-cli` in the Sandbox image (task 8.1).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4", "1.6", "2.1", "8.1", "8.2", "10.1", "10.3", "13.1", "15.1"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.2", "2.3", "3.1", "4.1", "5.1", "6.3", "9.1", "13.2", "14.1", "15.2", "19.1", "20.1", "22.1"] },
    { "id": 3, "tasks": ["2.4", "3.2", "4.2", "4.3", "5.2", "6.1", "6.4", "9.2", "9.3", "11.1", "14.2", "18.1", "19.2", "20.2", "20.4"] },
    { "id": 4, "tasks": ["3.3", "5.3", "6.2", "6.5", "14.3", "19.3"] },
    { "id": 5, "tasks": ["5.4", "10.2", "14.4", "15.3", "18.2", "21.2", "22.2", "23.1"] },
    { "id": 6, "tasks": ["10.4", "11.2", "14.5", "14.6", "15.4", "16.1", "18.3", "23.2", "23.3"] },
    { "id": 7, "tasks": ["11.3", "16.2", "20.3", "21.1", "22.3", "23.4", "23.5", "24.1"] },
    { "id": 8, "tasks": ["20.5", "21.3", "22.4", "23.6", "24.2"] }
  ]
}
```
