# Requirements Document

## Introduction

Rayu Computer is a capability of the existing Rayu platform that turns a single natural-language prompt entered in the `rayu-web` chat interface (for example, "build a booking system for Cambodia") into a real, deployed, full-stack web application. A prompt is planned and built by the rayu-cli collaborator swarm running headlessly inside an isolated Docker sandbox on a single VPS. Build progress is streamed live to the browser, and on success the generated application is built into its own container, deployed behind a reverse proxy, and served at a unique subdomain `https://<id>.<base-domain>`.

Rayu Computer adds one new standalone service — the `rayu-orchestrator` — to the existing `rayu-cli` monorepo, alongside the four existing projects: `rayu` (the CLI), `rayu-backend` (NestJS + Prisma + MySQL accounts API, prefix `/api`), `rayu-gateway` (Go + chi + Redis streaming gateway), and `rayu-web` (Next.js 15 + Clerk frontend). The existing `deploy/` Docker Compose stack (which today terminates TLS with Caddy) is extended to run the orchestrator, the sandbox/app-container runtime, a wildcard-subdomain reverse proxy, the egress-restricted networks, and the `/srv/builds` workspace volume.

> **Note — decisions to confirm.** This document deliberately specifies several capabilities as technology-neutral requirements because the source design plan and the existing codebase disagree on the concrete technology. These open questions are tracked in the [Open Questions and Decisions to Confirm](#open-questions-and-decisions-to-confirm) section and MUST be resolved before or during design: (a) the **reverse-proxy engine** (the design plan proposes Traefik, but the existing `deploy/` stack uses Caddy); (b) the **durable-store engine** (the design plan assumes Postgres, but the existing `rayu-backend` uses MySQL via Prisma); and (c) the **orchestrator implementation language** (Go, matching `rayu-gateway`, versus Node/Bun, matching `rayu`/rayu-cli). The acceptance criteria below intentionally avoid naming a specific proxy, database engine, or implementation language; they state the routing, persistence, and service behavior that any chosen technology MUST satisfy.

This document specifies requirements for the following in-scope components:

1. Builder Orchestrator (`rayu-orchestrator` — HTTP API, build lifecycle/state machine, coordination)
2. Sandbox Runtime (isolated build container image and hardened run policy)
3. Headless Swarm Invocation (the entry script that drives rayu-cli)
4. Progress Streaming (ProgressEvent model, stream-json mapping, SSE, replay)
5. Deploy Subsystem (build artifact parsing, app container build/run, health checks)
6. Reverse Proxy and Subdomain Routing (wildcard subdomain routing, wildcard TLS, wildcard DNS)
7. Tenancy, Authentication, Authorization, Quotas, and BYOK
8. Lifecycle and Operations (idle reaping, cleanup, GC, logs, metrics)
9. Security Model (untrusted code execution, isolation, key protection)
10. The `rayu-web` "Rayu Computer" frontend panel (prompt submission, live progress rendering, resumable streaming, cancel, and the live application link)

The end-to-end request path is: the `rayu-web` "Rayu Computer" panel submits the prompt to `rayu-backend` (authenticated with the Clerk → Rayu JWT exchange that `rayu-web` already uses); `rayu-backend` calls the Orchestrator's `POST /v1/builds` over the service-authentication channel; the browser subscribes to the Orchestrator's SSE progress stream proxied through `rayu-gateway`; and on completion the panel renders the clickable `https://<Build_Id>.<Base_Domain>` link. The internal mechanics of `rayu-backend` and `rayu-gateway` beyond this contract are out of scope and are represented here as the **integration contract** the Orchestrator exposes and consumes (Requirement 1); the `rayu-web` panel behavior is specified directly (Requirements 23–25).

The Orchestrator is a new standalone service. Its implementation language is a decision to confirm (see [Open Questions and Decisions to Confirm](#open-questions-and-decisions-to-confirm)): Go would share a language with `rayu-gateway` and provides a first-class Docker SDK, while Node/Bun would share a language with `rayu`/rayu-cli. No acceptance criterion in this document depends on the chosen language. The existing `rayu` CLI code is not modified (the "do not modify rayu/" boundary), and the only rayu-side dependency is the runtime Build_Addendum prompt supplied at invocation time, which instructs the swarm to emit a `Dockerfile` and a `rayu-build.json` Build_Manifest.

## Out of Scope (Deferred Non-Goals)

The following are explicitly out of scope for this spec and are not specified or required by any acceptance criterion below:

- **Billing, metering, and payments** for builds or deployed applications.
- **Horizontal scaling beyond a single VPS** (multi-host scheduling, clustering). The first increment uses an in-process worker pool on one VPS rather than an external job queue (no Redis/NATS-backed build queue).
- **Custom user-supplied domains** for deployed applications; only `<Build_Id>.<Base_Domain>` subdomains are served.
- **Long-term persistence, editing, or resume** of generated projects after a Build reaches a Terminal_Status, and any full in-browser IDE.
- **Modification of the `rayu` CLI source**; the sole rayu-side coupling is the runtime Build_Addendum prompt.
- **The internal implementation of `rayu-backend` and `rayu-gateway`** beyond the integration contract in Requirement 1 (for example, how `rayu-backend` performs the Clerk → Rayu JWT exchange, or how `rayu-gateway` proxies SSE).

These items may be addressed in future specs but MUST NOT be assumed present by this one.

**Deferred non-goals (explicitly out of scope for this spec):** billing/payments, horizontal scaling beyond a single VPS, custom user domains, long-term persistence or editing of generated projects, and a full in-browser IDE.

## Open Questions and Decisions to Confirm

The source design plan and the existing `rayu-cli` codebase disagree on three concrete technology choices. This document does **not** resolve them; it states each as a technology-neutral requirement and records the open decision here. Each MUST be confirmed before or during the design phase. Resolving any of these decisions does not change the acceptance criteria below — only the chosen implementation.

1. **Reverse-proxy engine (routing requirement is fixed; engine is open).** The design plan proposes **Traefik** (Docker provider auto-discovery, wildcard TLS via DNS-01). The existing `deploy/` stack already terminates TLS with **Caddy**. The requirement (see Requirement 14) is "wildcard subdomain routing to per-app containers with automatic wildcard TLS"; whether that is delivered by Traefik, Caddy, or another proxy is a decision to confirm. Considerations: reusing Caddy avoids running two proxies on one VPS; adopting Traefik matches the plan's label-based auto-discovery design.

2. **Durable-store engine (persistence requirements are fixed; engine is open).** The design plan assumes **Postgres**. The existing `rayu-backend` uses **MySQL via Prisma**, and `rayu-gateway` also reads MySQL. The requirements (see Requirements 9 and 16) specify durable, append-only, gap-free per-build event persistence and ownership records; the concrete engine (Postgres vs MySQL, and whether to reuse the existing MySQL instance or stand up a separate database) is a decision to confirm. Considerations: reusing the existing MySQL keeps one database engine across services; Postgres matches the plan and offers stronger append-only/sequence ergonomics.

3. **Orchestrator implementation language.** The design plan recommends **Go** (shares a language with `rayu-gateway`, first-class Docker SDK, strong concurrency); the alternative is **Node/Bun** (shares a language with `rayu`/rayu-cli). This is a decision to confirm. No acceptance criterion in this document depends on the chosen language.

Note also that the first increment intentionally uses an in-process worker pool (no external Redis/NATS build queue) per the deferred scaling non-goal; introducing an external queue is deferred, not an open question for this spec.

## Glossary

- **Rayu_Computer**: The complete capability described by this document, comprising all in-scope components below (the `rayu-orchestrator` service, the sandbox/deploy/proxy runtime, and the `rayu-web` "Rayu Computer" panel).
- **Orchestrator**: The standalone `rayu-orchestrator` backend service that exposes the build API, drives the build lifecycle state machine, manages sandboxes, parses progress, triggers deploys, and configures routing. Its implementation language (Go or Node/Bun) is a decision to confirm and is not constrained by any acceptance criterion.
- **Caller**: An authenticated upstream service that invokes the Orchestrator API on behalf of an End_User — in this platform, `rayu-backend` (which creates builds) and `rayu-gateway` (which proxies the progress stream to the browser). The internal mechanics of these services are out of scope; they are represented only by the integration contract.
- **End_User**: The human who entered a prompt in the `rayu-web` "Rayu Computer" panel. The End_User does not call the Orchestrator directly; a Caller acts on the End_User's behalf and supplies the End_User identity.
- **Rayu_Web**: The existing Next.js 15 + Clerk frontend application (`rayu-web`) that hosts the Rayu_Computer_Panel.
- **Rayu_Computer_Panel**: The "Rayu Computer" chat interface added to `rayu-web` from which the End_User submits a prompt, watches live build progress, cancels a Build, and opens the deployed application.
- **Build**: A single request to generate and deploy an application from one prompt, identified by a unique Build_Id, progressing through the Build lifecycle.
- **Build_Id**: A globally unique, URL-safe identifier assigned by the Orchestrator to each Build and used as the deployed application's subdomain label.
- **Build_Record**: The persisted record of a Build in the `builds` data store, including status, timestamps, owner, and outcome.
- **Build_Event**: A single immutable progress record written to the append-only `build_events` store, carrying a monotonic per-build sequence number.
- **Route_Record**: The persisted mapping in the `routes` data store from a Build_Id (and its subdomain) to a running App_Container.
- **Sandbox**: The isolated Docker container in which the headless swarm runs to generate the application. Also called the build container.
- **Sandbox_Image**: The container image used to create a Sandbox, based on `node:22-bookworm-slim` with a pinned rayu-cli version.
- **Entry_Script**: The process inside the Sandbox that invokes rayu-cli headlessly with the End_User prompt and the Build_Addendum.
- **Build_Addendum**: A runtime prompt fragment appended to the End_User prompt that instructs the collaborator swarm to emit a `Dockerfile` and a `rayu-build.json` manifest. This is the only rayu-side dependency.
- **Swarm**: The rayu-cli collaborator swarm engaged via the `/collaborator_swarm` command with the `--agent-teams` flag, which plans and builds the application.
- **Stream_Json_Message**: A single newline-delimited JSON object emitted by rayu-cli on stdout when run with `--output-format stream-json` (message `type` values include `system`, `assistant`, `tool_use`, `tool_result`, `stream_event`, and `result`).
- **Progress_Event**: A normalized event produced by the Orchestrator and delivered to Callers, with a `kind` of one of: `status`, `phase`, `agent`, `tool_use`, `tool_result`, `file_change`, `log`, `deploy`, `result`, or `error`.
- **SSE_Stream**: The Server-Sent Events HTTP response that delivers Progress_Events for a Build, using the SSE `id:` field for the per-build sequence number and supporting resume via the `Last-Event-ID` request header.
- **Sequence_Number**: A monotonically increasing, gap-free integer assigned per Build to each Build_Event, starting at 1.
- **Build_Manifest**: The `rayu-build.json` file emitted into the workspace by the Swarm, describing how to build and run the generated application.
- **App_Container**: The container that runs a deployed generated application, separate from the Sandbox.
- **Reverse_Proxy**: The reverse-proxy component that terminates TLS and routes inbound subdomain requests to the correct App_Container by discovering App_Containers through the container runtime (for example, via container labels). The concrete proxy engine is a decision to confirm (the design plan proposes Traefik; the existing `deploy/` stack uses Caddy); the acceptance criteria specify only the routing and TLS behavior the chosen engine MUST provide.
- **Durable_Store**: The persistent datastore backing the `builds`, `build_events`, and `routes` records. The concrete database engine is a decision to confirm (the design plan assumes Postgres; the existing `rayu-backend` uses MySQL via Prisma); the acceptance criteria specify only the persistence, ordering, and append-only behavior the chosen engine MUST provide.
- **Base_Domain**: The configured wildcard domain under which deployed applications are served (production uses a real wildcard domain; development uses an sslip.io domain).
- **Subdomain**: The host `<Build_Id>.<Base_Domain>` at which a deployed application is served.
- **BYOK_Key**: The End_User's own AI provider API key, supplied per Build, held only in memory, and never persisted.
- **Concurrency_Quota**: The maximum number of simultaneously active Builds permitted for one End_User.
- **Daily_Quota**: The maximum number of Builds one End_User may start within a rolling 24-hour window.
- **Idle_Reaper**: The Orchestrator component that terminates App_Containers that have exceeded their time-to-live or last-access threshold.
- **TTL**: The maximum lifetime of a deployed App_Container before it is eligible for reaping.
- **Active_Build**: A Build whose status is `queued`, `provisioning`, `building`, `build_succeeded`, or `deploying`.
- **Terminal_Status**: A Build status from which no further transition occurs: `live`, `failed`, `canceled`, or `terminated`.

## Requirements

### Requirement 1: Integration Contract (Build API surface)

**User Story:** As a Caller, I want a stable HTTP API to start, observe, cancel, and delete builds, so that the website backend and gateway can drive build creation on behalf of end users without knowing internal implementation details.

#### Acceptance Criteria

1. WHEN the Orchestrator receives an authenticated `POST /v1/builds` request containing a non-empty prompt and the owning End_User identity, THE Orchestrator SHALL create a Build_Record with a unique Build_Id and a status of `queued`, and SHALL respond with HTTP 201 and a body containing the Build_Id, the status, and the stream URL `GET /v1/builds/{Build_Id}/stream`.
2. IF a `POST /v1/builds` request omits the prompt, supplies an empty prompt, or omits the owning End_User identity, THEN THE Orchestrator SHALL reject the request with HTTP 400 and a body containing a machine-readable error code and a human-readable message, and SHALL NOT create a Build_Record.
3. WHEN the Orchestrator receives an authenticated `GET /v1/builds/{Build_Id}` request for an existing Build owned by the requester, THE Orchestrator SHALL respond with HTTP 200 and a body containing the Build_Id, the current status, the creation and last-updated timestamps, and (WHERE the status is `live`) the served Subdomain URL.
4. IF a `GET /v1/builds/{Build_Id}`, `GET /v1/builds/{Build_Id}/stream`, `POST /v1/builds/{Build_Id}/cancel`, or `DELETE /v1/builds/{Build_Id}` request references a Build_Id that does not exist, THEN THE Orchestrator SHALL respond with HTTP 404.
5. WHEN the Orchestrator receives an authenticated `POST /v1/builds/{Build_Id}/cancel` request for an Active_Build owned by the requester, THE Orchestrator SHALL transition the Build toward the `canceled` status and SHALL respond with HTTP 202.
6. WHEN the Orchestrator receives an authenticated `DELETE /v1/builds/{Build_Id}` request for an existing Build owned by the requester, THE Orchestrator SHALL stop any running Sandbox and App_Container for that Build, transition the Build to `terminated`, remove its Route_Record, and respond with HTTP 200.
7. WHEN the Orchestrator receives a `GET /healthz` request, THE Orchestrator SHALL respond with HTTP 200 WHILE the Orchestrator is able to reach its data store and the container runtime, and SHALL respond with HTTP 503 otherwise.
8. WHEN the Orchestrator receives a `GET /metrics` request, THE Orchestrator SHALL respond with HTTP 200 and a body in Prometheus text exposition format.
9. THE Orchestrator SHALL accept and return all `/v1/builds` request and response bodies as JSON with the media type `application/json`.

### Requirement 2: Build Lifecycle State Machine

**User Story:** As an operator, I want every build to move through an explicit, well-defined state machine, so that build status is always unambiguous and recoverable.

#### Acceptance Criteria

1. THE Orchestrator SHALL represent each Build's status as exactly one of: `queued`, `provisioning`, `building`, `build_succeeded`, `deploying`, `live`, `failed`, `canceled`, or `terminated`.
2. THE Orchestrator SHALL permit Build status transitions only along the following directed edges: `queued`→`provisioning`, `provisioning`→`building`, `building`→`build_succeeded`, `build_succeeded`→`deploying`, `deploying`→`live`; AND from any non-terminal status to `failed`, `canceled`, or `terminated`.
3. IF a transition is attempted that is not one of the permitted edges, THEN THE Orchestrator SHALL reject the transition, retain the current status, and write a `log` Progress_Event recording the rejected transition.
4. WHEN a Build's status changes, THE Orchestrator SHALL persist the new status to the Build_Record and SHALL emit a `status` Progress_Event carrying the new status before processing the next transition for that Build.
5. WHILE a Build is in a Terminal_Status, THE Orchestrator SHALL reject any request to cancel that Build with HTTP 409.
6. WHEN a Build enters the `failed` status, THE Orchestrator SHALL record a failure reason on the Build_Record and SHALL emit an `error` Progress_Event containing that reason.
7. IF the Orchestrator restarts WHILE a Build is in a non-terminal status, THEN on startup THE Orchestrator SHALL reconcile that Build by inspecting the runtime and SHALL transition the Build to `failed` WHERE its Sandbox or App_Container is no longer present.

### Requirement 3: Build Queue and Admission Control

**User Story:** As an operator, I want builds to be admitted and queued within fixed capacity limits, so that a single VPS is never overwhelmed by concurrent builds.

#### Acceptance Criteria

1. THE Orchestrator SHALL enforce a configured maximum number of concurrently `building` Sandboxes across all End_Users.
2. WHILE the number of concurrently `building` Sandboxes equals the configured maximum, THE Orchestrator SHALL hold newly created Builds in the `queued` status until a Sandbox slot becomes available.
3. WHEN a Sandbox slot becomes available AND one or more Builds are `queued`, THE Orchestrator SHALL admit the Build that has been `queued` longest and transition it to `provisioning`.
4. IF admitting a `queued` Build would cause the requesting End_User's active count to exceed the End_User's Concurrency_Quota, THEN THE Orchestrator SHALL keep that Build `queued` and SHALL NOT transition it to `provisioning` until the End_User's active count falls below the Concurrency_Quota.
5. WHILE a Build is `queued`, THE Orchestrator SHALL emit a `status` Progress_Event that reports the Build's current position in the queue.

### Requirement 4: Sandbox Runtime Image

**User Story:** As a platform engineer, I want a pinned, reproducible sandbox image, so that builds run in a known environment containing the exact rayu-cli version.

#### Acceptance Criteria

1. THE Sandbox_Image SHALL be built from the `node:22-bookworm-slim` base image.
2. THE Sandbox_Image SHALL include a single pinned version of rayu-cli identified by an exact version string recorded in the image build configuration.
3. THE Sandbox_Image SHALL define a non-root default user with UID 10001.
4. THE Sandbox_Image SHALL include the Entry_Script as its container entrypoint.
5. WHEN the Sandbox_Image is built, THE build process SHALL fail WHERE the requested pinned rayu-cli version cannot be installed.

### Requirement 5: Sandbox Hardened Run Policy

**User Story:** As a security engineer, I want every sandbox started with a strict, least-privilege run policy, so that untrusted AI-generated code cannot harm the host or other tenants.

#### Acceptance Criteria

1. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL drop all Linux capabilities for that container.
2. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL run the container with a read-only root filesystem and SHALL provide a writable workspace only via a dedicated bind-mounted directory.
3. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL run the container process as the non-root UID 10001.
4. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL apply a seccomp profile that restricts available system calls.
5. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL set the no-new-privileges flag on the container.
6. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL apply a configured maximum process (pids) limit, a configured CPU limit, and a configured memory limit to the container.
7. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL attach the container to an egress-restricted network that permits outbound connections only to the configured AI provider endpoints and package registries and denies all other outbound destinations, including link-local and cloud metadata addresses.
8. IF a Sandbox process exceeds its configured memory limit, THEN the container runtime SHALL terminate the Sandbox, AND THE Orchestrator SHALL transition the corresponding Build to `failed` with a resource-exhaustion reason.

### Requirement 6: Headless Swarm Invocation

**User Story:** As the orchestrator, I want a deterministic entry script that drives rayu-cli headlessly, so that each build engages the collaborator swarm with the correct prompt, flags, and provider key.

#### Acceptance Criteria

1. WHEN a Build enters the `building` status, THE Entry_Script SHALL invoke rayu-cli with the `/collaborator_swarm` command, the End_User prompt, and the Build_Addendum as input.
2. THE Entry_Script SHALL invoke rayu-cli with the flags `--agent-teams`, `--input-format stream-json`, `--output-format stream-json`, `--verbose`, `--dangerously-skip-permissions`, and `--model` set to the configured build model.
3. THE Entry_Script SHALL include the `--print` flag in the rayu-cli invocation; HOWEVER, WHERE only the `--print` flag is absent while all flags in acceptance criterion 2 are present, THE Entry_Script SHALL proceed with the invocation, because `--print` affects output formatting only.
4. THE Build_Addendum SHALL instruct the Swarm to produce, in the workspace, a `Dockerfile` and a `rayu-build.json` Build_Manifest describing how to build and run the generated application.
5. WHEN the Orchestrator starts a Sandbox, THE Orchestrator SHALL provide the BYOK_Key to the Entry_Script through an in-memory channel (environment variable or stream) and SHALL NOT write the BYOK_Key to any file inside the Sandbox.
6. WHILE rayu-cli is running, THE Entry_Script SHALL forward every Stream_Json_Message emitted on rayu-cli stdout to the Orchestrator without buffering beyond one line.
7. WHEN rayu-cli emits a Stream_Json_Message with `type` equal to `result`, THE Entry_Script SHALL treat the build generation as complete and SHALL report the result's success or error subtype to the Orchestrator.
8. THE Orchestrator SHALL configure each Sandbox so that the rayu-cli `--dangerously-skip-permissions` safety gate is satisfied, namely the container is detectable as a Docker/sandbox environment, runs without root privileges, and has no general internet access.

### Requirement 7: Build Completion and Workspace Validation

**User Story:** As the orchestrator, I want to validate the workspace after generation completes, so that only builds with the required deploy artifacts proceed to deployment.

#### Acceptance Criteria

1. WHEN the Entry_Script reports a `result` with a success subtype, THE Orchestrator SHALL validate that the workspace contains both a `Dockerfile` and a parseable `rayu-build.json` Build_Manifest.
2. IF workspace validation succeeds, THEN THE Orchestrator SHALL transition the Build from `building` to `build_succeeded`.
3. IF the Entry_Script reports a `result` with an error subtype, THEN THE Orchestrator SHALL transition the Build to `failed` and SHALL record the reported error subtype as the failure reason.
4. IF workspace validation fails because the `Dockerfile` is absent, the `rayu-build.json` is absent, or the `rayu-build.json` cannot be parsed, THEN THE Orchestrator SHALL transition the Build to `failed` and SHALL record a missing-or-invalid-artifact failure reason.
5. IF the elapsed time in the `building` status exceeds the configured build timeout, THEN THE Orchestrator SHALL terminate the Sandbox and transition the Build to `failed` with a timeout reason.

### Requirement 8: Progress Event Model and Mapping

**User Story:** As a Caller, I want raw swarm output normalized into a stable event model, so that the chat UI can render build progress without parsing rayu-cli internals.

#### Acceptance Criteria

1. THE Orchestrator SHALL represent each Progress_Event with a `kind` field whose value is exactly one of: `status`, `phase`, `agent`, `tool_use`, `tool_result`, `file_change`, `log`, `deploy`, `result`, or `error`.
2. WHEN the Orchestrator receives a Stream_Json_Message of `type` `assistant`, THE Orchestrator SHALL map it to a `log` Progress_Event carrying the assistant text.
3. WHEN the Orchestrator receives a Stream_Json_Message describing a tool invocation, THE Orchestrator SHALL map it to a `tool_use` Progress_Event carrying the tool name.
4. WHEN the Orchestrator receives a Stream_Json_Message describing a tool result, THE Orchestrator SHALL map it to a `tool_result` Progress_Event.
5. WHEN the Orchestrator receives a Stream_Json_Message indicating that a file in the workspace was created or modified, THE Orchestrator SHALL map it to a `file_change` Progress_Event carrying the workspace-relative file path.
6. WHEN the Orchestrator receives a Stream_Json_Message of `type` `result`, THE Orchestrator SHALL map it to a `result` Progress_Event carrying the success or error outcome.
7. IF the Orchestrator receives a line on rayu-cli stdout that is not parseable as a Stream_Json_Message, THEN THE Orchestrator SHALL emit a `log` Progress_Event containing the raw line and SHALL continue processing subsequent lines.
8. THE Orchestrator SHALL include the Build_Id and the assigned Sequence_Number in every Progress_Event it emits.

### Requirement 9: Progress Event Persistence and Replay

**User Story:** As a Caller, I want every progress event durably recorded with a sequence number, so that a disconnected client can resume the stream without missing or duplicating events.

#### Acceptance Criteria

1. WHEN the Orchestrator produces a Progress_Event for a Build, THE Orchestrator SHALL assign the next Sequence_Number for that Build and SHALL append the event to the `build_events` store before delivering it to any SSE_Stream.
2. THE Orchestrator SHALL assign Sequence_Numbers per Build as consecutive integers beginning at 1 with no gaps and no repeats.
3. THE Orchestrator SHALL treat the `build_events` store as append-only and SHALL NOT modify or delete a Build_Event while its Build is not in a Terminal_Status.
4. WHEN the Orchestrator replays Build_Events for a Build, THE Orchestrator SHALL deliver them in ascending Sequence_Number order.
5. FOR ALL Builds, the ordered set of persisted Build_Events SHALL allow the full Progress_Event history up to the latest Sequence_Number to be reconstructed by reading the `build_events` store (round-trip property).

### Requirement 10: SSE Streaming and Resume

**User Story:** As an end user watching in the browser, I want live progress over a resumable stream, so that I see the build unfold and recover seamlessly after a brief network drop.

#### Acceptance Criteria

1. WHEN the Orchestrator receives an authenticated `GET /v1/builds/{Build_Id}/stream` request for a Build owned by the requester, THE Orchestrator SHALL respond with HTTP 200, the media type `text/event-stream`, and SHALL stream subsequent Progress_Events for that Build as SSE messages.
2. THE Orchestrator SHALL set the SSE `id:` field of each streamed message to the Progress_Event's Sequence_Number.
3. WHEN a `GET /v1/builds/{Build_Id}/stream` request includes a `Last-Event-ID` header with value N, THE Orchestrator SHALL first replay all persisted Build_Events for that Build with Sequence_Number greater than N in ascending order, and SHALL then continue with live events.
4. WHILE an SSE_Stream is open and no Progress_Event has been sent for 15 seconds, THE Orchestrator SHALL send an SSE heartbeat comment to keep the connection alive.
5. WHEN a Build reaches a Terminal_Status, THE Orchestrator SHALL deliver the final Progress_Event and SHALL then close the SSE_Stream.
6. WHERE a `GET /v1/builds/{Build_Id}/stream` request is made for a Build already in a Terminal_Status, THE Orchestrator SHALL replay all persisted Build_Events in ascending Sequence_Number order and SHALL then close the stream.

### Requirement 11: Deploy Artifact Parsing

**User Story:** As the orchestrator, I want to parse and validate the generated build manifest, so that the application is built and run exactly as the manifest specifies.

#### Acceptance Criteria

1. WHEN a Build enters `deploying`, THE Orchestrator SHALL parse the `rayu-build.json` Build_Manifest from the workspace.
2. THE Orchestrator SHALL validate that the parsed Build_Manifest specifies the application type, the internal port the application listens on, and the run command or entrypoint.
3. IF the Build_Manifest fails validation, THEN THE Orchestrator SHALL transition the Build to `failed` with an invalid-manifest reason.
4. THE Orchestrator SHALL serialize the parsed Build_Manifest back to an equivalent canonical representation, AND parsing a Build_Manifest then serializing it then parsing the result SHALL yield an equivalent Build_Manifest (round-trip property).
5. WHILE the parsed Build_Manifest is valid, THE Orchestrator SHALL select the deploy strategy from the declared application type: WHERE the application type is static, THE Orchestrator SHALL apply the static-site deploy strategy; WHERE the application type is a Node service, THE Orchestrator SHALL apply the Node service deploy strategy.
6. IF the Build_Manifest has not yet been successfully parsed and validated, THEN THE Orchestrator SHALL NOT apply any deploy strategy.

### Requirement 12: Application Build and Run

**User Story:** As the orchestrator, I want to build and run each generated application in its own constrained container, so that deployed apps are isolated and resource-bounded.

#### Acceptance Criteria

1. WHEN a Build is in `deploying` AND the Build_Manifest is valid, THE Orchestrator SHALL build a container image from the workspace `Dockerfile` on the host.
2. IF the host image build fails, THEN THE Orchestrator SHALL transition the Build to `failed` with an image-build-failure reason and SHALL emit a `deploy` Progress_Event describing the failure.
3. WHEN the application image build succeeds, THE Orchestrator SHALL run an App_Container from that image with a configured CPU limit, a configured memory limit, a process (pids) limit, no added Linux capabilities, and the no-new-privileges flag set.
4. WHEN the Orchestrator runs an App_Container, THE Orchestrator SHALL attach it to an egress-restricted network that denies access to link-local and cloud metadata addresses.
5. WHILE deploying, THE Orchestrator SHALL emit `deploy` Progress_Events covering the start of the image build, image-build completion, and App_Container start; WHERE two or more of these milestones occur within a configured coalescing interval, THE Orchestrator MAY combine them into a single `deploy` Progress_Event.

### Requirement 13: Deployment Health Check

**User Story:** As an end user, I want my app marked live only after it actually responds, so that the subdomain I am given works when I open it.

#### Acceptance Criteria

1. WHEN an App_Container has started, THE Orchestrator SHALL poll the application's configured internal port until the application responds successfully or the configured health-check deadline elapses.
2. IF the application responds successfully before the health-check deadline, THEN THE Orchestrator SHALL transition the Build from `deploying` to `live`.
3. IF the health-check deadline elapses before the application responds successfully, THEN THE Orchestrator SHALL stop the App_Container and transition the Build to `failed` with a health-check-failure reason.
4. WHEN a Build transitions to `live`, THE Orchestrator SHALL emit a `deploy` Progress_Event containing the served Subdomain URL.

### Requirement 14: Reverse Proxy and Subdomain Routing

**User Story:** As an end user, I want my deployed app served at a unique HTTPS subdomain, so that I can open and share it immediately.

#### Acceptance Criteria

1. WHEN the Orchestrator runs an App_Container for a Build, THE Orchestrator SHALL attach Reverse_Proxy routing labels that map the host `<Build_Id>.<Base_Domain>` to that App_Container's internal port.
2. THE Reverse_Proxy SHALL discover App_Containers through the container runtime provider and SHALL route an inbound request for host `<Build_Id>.<Base_Domain>` to the App_Container whose labels declare that host.
3. THE Reverse_Proxy SHALL terminate TLS for all `*.<Base_Domain>` hosts using a wildcard certificate obtained via the DNS-01 challenge.
4. WHEN the Orchestrator deploys a Build in the production environment, THE Orchestrator SHALL use the configured wildcard Base_Domain backed by wildcard DNS; WHEN deploying in the development environment, THE Orchestrator SHALL derive the Subdomain from an sslip.io Base_Domain.
5. WHEN a Build transitions to `live`, THE Orchestrator SHALL create a Route_Record mapping the Build_Id and Subdomain to the running App_Container.
6. IF the Reverse_Proxy receives a request for a host that has no matching Route_Record, THEN THE Reverse_Proxy SHALL respond with HTTP 404.
7. THE Reverse_Proxy SHALL place each App_Container on a network that prevents one App_Container from initiating connections to another App_Container.

### Requirement 15: Service Authentication

**User Story:** As a security engineer, I want only trusted callers to reach the build API, so that unauthorized parties cannot trigger builds or read build progress.

#### Acceptance Criteria

1. WHEN the Orchestrator receives a request to any `/v1/builds` route, THE Orchestrator SHALL authenticate the Caller using the configured service-authentication mechanism (mutual TLS or a signed service token) before processing the request.
2. IF a `/v1/builds` request lacks valid service authentication, THEN THE Orchestrator SHALL reject it with HTTP 401 and SHALL NOT create, mutate, or disclose any Build.
3. THE Orchestrator SHALL exempt only the `GET /healthz` and `GET /metrics` routes from Caller authentication.
4. IF authenticated request volume from a single Caller exceeds the configured request-rate limit, THEN THE Orchestrator SHALL reject excess requests with HTTP 429.

### Requirement 16: Per-User Authorization

**User Story:** As an end user, I want only my own builds visible and controllable through my account, so that other users cannot see or affect my builds.

#### Acceptance Criteria

1. WHEN the Orchestrator creates a Build, THE Orchestrator SHALL record the owning End_User identity supplied by the Caller on the Build_Record.
2. WHEN the Orchestrator receives a `GET /v1/builds/{Build_Id}`, `GET /v1/builds/{Build_Id}/stream`, `POST /v1/builds/{Build_Id}/cancel`, or `DELETE /v1/builds/{Build_Id}` request, THE Orchestrator SHALL authorize the request only WHERE the End_User identity on the request matches the owning End_User identity on the Build_Record.
3. IF the requesting End_User identity does not match the Build's owning End_User identity, THEN THE Orchestrator SHALL respond with HTTP 404 and SHALL NOT disclose whether the Build exists.

### Requirement 17: Quotas

**User Story:** As an operator, I want per-user concurrency and daily build limits, so that one user cannot monopolize VPS capacity.

#### Acceptance Criteria

1. THE Orchestrator SHALL enforce a configured per-user Concurrency_Quota counting that End_User's Active_Builds.
2. IF creating a Build would cause an End_User's Active_Build count to exceed the Concurrency_Quota, THEN THE Orchestrator SHALL reject the `POST /v1/builds` request with HTTP 429 and a quota-exceeded error code.
3. THE Orchestrator SHALL enforce a configured per-user Daily_Quota counting Builds the End_User started within the trailing 24-hour window.
4. IF creating a Build would exceed the End_User's Daily_Quota, THEN THE Orchestrator SHALL reject the `POST /v1/builds` request with HTTP 429 and a daily-quota-exceeded error code.
5. WHEN an Active_Build reaches a Terminal_Status, THE Orchestrator SHALL decrement that End_User's Active_Build count within the Concurrency_Quota accounting.

### Requirement 18: BYOK Key Handling and Redaction

**User Story:** As an end user, I want my provider API key used only in memory and never stored or logged, so that my key cannot leak.

#### Acceptance Criteria

1. THE Orchestrator SHALL hold each BYOK_Key only in process memory for the duration of the Build and SHALL NOT write the BYOK_Key to the `builds`, `build_events`, or `routes` data stores.
2. THE Orchestrator SHALL pass the BYOK_Key to a Sandbox only through an in-memory channel and SHALL NOT persist the BYOK_Key to any host file or container image.
3. WHEN the Orchestrator writes a log entry or produces a Progress_Event, THE Orchestrator SHALL redact the active BYOK_Key and any substring matching a configured secret pattern before the log entry or Progress_Event is persisted or delivered, AND THE Orchestrator SHALL redact the active BYOK_Key even WHERE no secret pattern is configured.
4. WHEN a Build reaches a Terminal_Status, THE Orchestrator SHALL remove the BYOK_Key from process memory.
5. IF a Stream_Json_Message from rayu-cli contains the BYOK_Key, THEN THE Orchestrator SHALL redact the key before mapping the message to a Progress_Event.

### Requirement 19: Idle Reaping and Application Lifecycle

**User Story:** As an operator, I want idle deployed apps automatically retired, so that the VPS reclaims resources from abandoned applications.

#### Acceptance Criteria

1. THE Orchestrator SHALL record a last-access timestamp for each `live` Build's App_Container, AND WHEN the Reverse_Proxy serves a request to that App_Container, THE Orchestrator SHALL update that last-access timestamp; both the recording and the updating are mandatory.
2. WHILE a Build is `live`, THE Idle_Reaper SHALL evaluate the App_Container against its configured TTL and its configured idle (last-access) threshold.
3. WHEN a `live` Build's App_Container exceeds its configured TTL OR exceeds its configured idle threshold, THE Idle_Reaper SHALL stop the App_Container, remove its Route_Record, and transition the Build to `terminated`.
4. WHEN the Idle_Reaper terminates an App_Container, THE Orchestrator SHALL record the reaping reason on the Build_Record.

### Requirement 20: Cleanup and Orphan Garbage Collection

**User Story:** As an operator, I want sandboxes, workspaces, and orphaned containers cleaned up automatically, so that disk and runtime resources do not leak over time.

#### Acceptance Criteria

1. WHEN a Build leaves the `building` status for any reason, THE Orchestrator SHALL stop and remove that Build's Sandbox container.
2. WHEN a Build reaches a Terminal_Status, THE Orchestrator SHALL remove that Build's bind-mounted workspace directory from the host.
3. WHILE the Orchestrator is running, THE Orchestrator SHALL periodically scan for Sandbox or App_Containers that have no corresponding non-terminal Build_Record and SHALL stop and remove each such orphaned container; THE periodic scan SHALL NOT remove a container that still has a corresponding non-terminal Build_Record, including a Build that has remained in `building` for an extended period (such Builds are handled by the build timeout in Requirement 7, not by orphan garbage collection).
4. WHEN the Orchestrator removes an orphaned container, THE Orchestrator SHALL record the removal in its structured logs with the container identifier and the orphan reason; IF writing that log entry fails, THEN THE Orchestrator SHALL still complete the container removal.

### Requirement 21: Observability — Structured Logs and Metrics

**User Story:** As an operator, I want structured logs and Prometheus metrics, so that I can monitor throughput, latency, and failures.

#### Acceptance Criteria

1. WHEN the Orchestrator processes a Build status transition, a Sandbox lifecycle event, or a deploy step, THE Orchestrator SHALL emit a structured log entry containing the Build_Id, the event type, and a timestamp.
2. THE Orchestrator SHALL expose at `GET /metrics` a counter of Builds by Terminal_Status, a gauge of currently `building` Sandboxes, a gauge of currently `live` App_Containers, and a histogram of build-generation duration.
3. WHEN a Build reaches a Terminal_Status, THE Orchestrator SHALL update the corresponding `/metrics` counter and SHALL record the build-generation duration in the histogram; WHERE a Build is canceled or interrupted before completion but a meaningful elapsed duration is available, THE Orchestrator MAY also record that duration in the histogram.
4. THE Orchestrator SHALL exclude any value matching a configured secret pattern from every structured log entry it emits.

### Requirement 22: Security Threat Mitigations

**User Story:** As a security engineer, I want explicit mitigations for the core threats of executing and exposing untrusted AI-generated code, so that the system limits blast radius across hosts, tenants, keys, and the public internet.

#### Acceptance Criteria

1. WHILE untrusted code runs in a Sandbox or App_Container, THE Rayu_Computer SHALL confine that code to the container's dropped-capability, non-root, resource-limited context such that the code cannot acquire host-level privileges (host-compromise mitigation).
2. THE Rayu_Computer SHALL bound every Sandbox and App_Container with process (pids), CPU, and memory limits such that a fork bomb or runaway process in one container cannot exhaust host resources for other containers (resource-exhaustion mitigation).
3. WHEN any container attempts an outbound connection to a link-local or cloud metadata address, THE egress-restricted network SHALL deny the connection (SSRF and metadata-theft mitigation).
4. THE Rayu_Computer SHALL place App_Containers on networks that prevent one tenant's App_Container from initiating connections to another tenant's App_Container or to a Sandbox (lateral-movement mitigation).
5. WHEN any component persists a log entry, a Build_Event, or a Progress_Event, THE component SHALL apply central redaction so that no BYOK_Key value is written (key-leakage mitigation).
6. WHEN the Orchestrator receives a build-triggering request, THE Orchestrator SHALL require valid Caller authentication and SHALL enforce the End_User's quotas before admitting the Build (unauthorized-trigger and auto-approve-abuse mitigation).
7. THE Rayu_Computer SHALL apply `--dangerously-skip-permissions` auto-approval only inside a Sandbox that satisfies the non-root, Docker/sandbox-detectable, and no-general-internet preconditions (auto-approve-misuse mitigation).


### Requirement 23: Rayu Computer Panel — Prompt Submission

**User Story:** As an End_User, I want to type a prompt into the Rayu Computer panel and start a build, so that I can generate a deployed application from the `rayu-web` chat interface.

#### Acceptance Criteria

1. THE Rayu_Computer_Panel SHALL be implemented as a `rayu-web` App Router client component that declares `'use client'` on its first line and exports `dynamic = 'force-dynamic'`.
2. WHILE the End_User is not authenticated with Clerk, THE Rayu_Computer_Panel SHALL prompt the End_User to sign in and SHALL NOT submit a Build.
3. WHEN the End_User submits a non-empty prompt, THE Rayu_Computer_Panel SHALL obtain a Rayu access token via the existing Clerk-to-Rayu session exchange and SHALL send the prompt to `rayu-backend` using the `NEXT_PUBLIC_RAYU_API_URL` base with a Bearer access token.
4. IF the End_User submits an empty or whitespace-only prompt, THEN THE Rayu_Computer_Panel SHALL block submission and SHALL display a validation message, without calling `rayu-backend`.
5. WHEN `rayu-backend` returns a created Build containing a Build_Id and stream URL, THE Rayu_Computer_Panel SHALL transition to the live-progress view for that Build_Id.
6. IF the build-creation request is rejected because the End_User has exceeded a quota (HTTP 429), THEN THE Rayu_Computer_Panel SHALL display a quota-exceeded message and SHALL allow the End_User to retry later.
7. IF the build-creation request fails for any other reason, THEN THE Rayu_Computer_Panel SHALL display an error message and SHALL re-enable prompt submission.
8. THE Rayu_Computer_Panel SHALL NOT collect, display, or transmit any BYOK_Key value in the browser unless the End_User explicitly enters one, and WHERE a BYOK_Key is entered, THE Rayu_Computer_Panel SHALL transmit it only over the authenticated HTTPS request to `rayu-backend` and SHALL NOT persist it in browser storage.

### Requirement 24: Rayu Computer Panel — Live Progress Rendering and Resume

**User Story:** As an End_User, I want to watch the build unfold live and recover after a brief disconnect, so that I can follow the swarm's phases, agents, tool calls, file changes, and logs in real time.

#### Acceptance Criteria

1. WHEN the Rayu_Computer_Panel enters the live-progress view for a Build_Id, THE Rayu_Computer_Panel SHALL open an SSE connection to the Build's progress stream through the `rayu-gateway` base URL configured in `NEXT_PUBLIC_RAYU_GATEWAY_URL`.
2. WHEN the Rayu_Computer_Panel receives a Progress_Event, THE Rayu_Computer_Panel SHALL render it according to its `kind`, displaying `phase` events as build phases, `agent` events as active agents, `tool_use` and `tool_result` events as tool activity, `file_change` events as changed workspace files, and `log` events as log output.
3. WHEN the Rayu_Computer_Panel receives a `status` Progress_Event, THE Rayu_Computer_Panel SHALL update the displayed Build status to the new lifecycle status.
4. THE Rayu_Computer_Panel SHALL retain the Sequence_Number of the most recently rendered Progress_Event for the current Build.
5. WHEN the SSE connection drops before the Build reaches a Terminal_Status, THE Rayu_Computer_Panel SHALL reconnect to the progress stream and SHALL send the last rendered Sequence_Number as the `Last-Event-ID` so that rendering resumes without missing or duplicated events.
6. WHEN the End_User activates the cancel control WHILE the Build is not in a Terminal_Status, THE Rayu_Computer_Panel SHALL send a cancel request for the Build_Id to `rayu-backend` and SHALL reflect the resulting status change.
7. WHILE no Progress_Event has been received for a configured interval, THE Rayu_Computer_Panel SHALL indicate that it is still connected and awaiting further progress.

### Requirement 25: Rayu Computer Panel — Completion and Failure Display

**User Story:** As an End_User, I want a clickable link to my deployed app on success and a clear reason on failure, so that I can open the generated application or understand why a build did not complete.

#### Acceptance Criteria

1. WHEN the Rayu_Computer_Panel observes the Build reach the `live` status, THE Rayu_Computer_Panel SHALL display the served `https://<Build_Id>.<Base_Domain>` Subdomain URL as a control that opens the deployed application in a new browser context.
2. WHEN the Rayu_Computer_Panel observes the Build reach the `failed` status, THE Rayu_Computer_Panel SHALL display the failure reason carried by the terminal `error` Progress_Event.
3. WHEN the Rayu_Computer_Panel observes the Build reach the `canceled` status, THE Rayu_Computer_Panel SHALL indicate that the Build was canceled.
4. WHEN the Build reaches any Terminal_Status, THE Rayu_Computer_Panel SHALL close the SSE connection and SHALL re-enable starting a new Build.
5. WHERE the End_User opens the Rayu_Computer_Panel for a Build that is already in a Terminal_Status, THE Rayu_Computer_Panel SHALL request the stream with no `Last-Event-ID`, render the replayed Progress_Event history in Sequence_Number order, and present the corresponding terminal outcome.
