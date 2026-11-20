# Network, providers, and protocol clients — Rust port research

Scope: everything in `rayu/src/` that talks to a model provider or an external
service. That is, the unit groups `rayu/src/services/api/` (plus `gemini/`,
`kiro/`, `copilot/`, `rayuHosted/`), `services/mcp/`, `services/lsp/`, `ipc/`,
`webBridge/`, `telegram/`, `bridge/`, `services/oauth/`, `services/rayuAuth/`,
`utils/telemetry/`, and the HTTP/TLS helpers `utils/proxy.ts`, `utils/http.ts`,
`utils/mtls.ts`, `utils/caCerts.ts`.

Ground rule for this document: every behavior claim cites the TypeScript
source that implements it; every Rust capability claim cites docs.rs or the
crate's source repository. Claims I could not verify from a primary source are
marked **UNVERIFIED**.

Versions were read from docs.rs/crates.io "latest" on 2026-11-19. ADR-007 already
fixes Tokio + reqwest + rustls + serde; this document assumes that stack and
narrows the choices inside it.

---

## 0. The structural finding that drives the crate choices

Rayu's internal representation is the **Anthropic Messages (beta)** request
shape. Every provider is a *transport* over that shape:

- `services/api/providerRegistry.ts:113-186` maps `ProviderKind` → `WireFormat`
  (`anthropic-messages`, `openai-chat`, `openai-responses`, `genai`,
  `codewhisperer`).
- `providerRegistry.ts:228-309` maps the same pair → a concrete client target.
- `providerRegistry.ts:444-712` is the only construction site; the main agent
  and every routed subagent share it.

Two consequences for the port:

1. **Do not port the SDKs; port the wire formats.** The CLI already owns request
   building (`claude.ts`), response shaping, and most streaming translation.
   The Anthropic SDK is used as an HTTP + SSE + type package, not as a
   provider abstraction.
2. **Several "SDK" dependencies are barely used or not used at all.**
   - `@google/genai` has no live import in `src/` — only comments
     (`utils/rayuConfig.ts:1354`, `utils/rayuProviders.ts:550`). Vertex and
     Code Assist are raw `fetch` (`gemini/vertexGenaiClient.ts:1-17,87-115`;
     `gemini/codeAssistClient.ts:355-379`).
   - `express` is not a dependency. The OAuth callback listener is
     `node:http.createServer` (`services/oauth/authCodeListener.ts:15-16,35,52`).
   - `@aws-sdk/client-bedrock-runtime` on the chat path is not used for Claude:
     `bedrockAnthropic.ts` uses bearer auth + `fetch` and only reuses the AWS
     event-stream framing. The AWS SDKs are used for the control plane and
     token counting (`utils/model/bedrock.ts:26-70`,
     `services/tokenEstimation.ts:472-523`, `utils/aws.ts:50-54`).
   - Provider payloads are **not** zod-validated. They are coerced through
     `Record<string, unknown>` (`openaiAdapter.ts:70-80`,
     `openaiResponsesAdapter.ts:47-61`). zod is used at config/auth/backend
     boundaries (`services/api/bootstrap.ts:8-20,93`,
     `services/mcp/config.ts:602`, `services/mcp/xaa.ts:102-113`).

---

## 1. Recommended crate table

| Concern | npm today | Recommended Rust | Version | Fit | One-line reason |
|---|---|---|---|---|---|
| HTTP client | `axios`, `undici`, `https-proxy-agent` | `reqwest` + `tokio` | 0.13.5 | partial | Covers requests, proxies, redirects, TLS identity; NO_PROXY/port/DNS and unix-socket parity need work |
| SSE parser | SDK-internal | `eventsource-stream` (or hand-rolled) | 0.2.3 | good | Spec-correct parser; still needs Rayu's `[DONE]`, comment-liveness and event-name rules layered on |
| Anthropic Messages | `@anthropic-ai/sdk` | none official; `reqwest` + own `ir` types | — | none | No official Rust SDK; community crates are immature. Build the IR directly |
| OpenAI Chat + Responses | `openai` | `async-openai` (features `chat-completion`, `responses`) | 0.43.0 | partial | Has both APIs and streaming; typed model can hide unknown fields and is not a byte-preserving proxy |
| Google GenAI | `@google/genai` (unused) | `reqwest` + `serde_json` | — | none / build | Vertex `:generateContent` and Code Assist are raw REST; community Gemini crates do not cover Vertex + Code Assist |
| AWS event-stream | `@aws-sdk/client-bedrock-runtime` framing | `aws-smithy-eventstream` | 0.61.6 | good | `MessageFrameDecoder` buffers partial frames and validates both CRCs; add Rayu's 4 MiB cap |
| AWS control plane / STS / SigV4 | `@aws-sdk/client-bedrock`, `client-sts` | `aws-sdk-bedrock`, `aws-config`, `aws-sigv4` | 1.156.0 / 1.13.3 / 1.6.6 | good | Official SDK; `aws-config` default chain, `aws-sigv4` for signing if IAM auth is ever needed |
| Google ADC | `google-auth-library` | `yup-oauth2` (preferred) or `google-cloud-auth` | 12.1.2 / 1.19.0 | partial | Both resolve ADC; neither mirrors Node's 5 s probe/source-order policy automatically |
| WebSocket (`ws`) | `ws` | `tokio-tungstenite` | 0.30.0 | good | TLS + async stream/sink; no documented proxy support |
| socket.io | `socket.io-client` | `rust_socketio` | 0.6.0 | partial | Namespace + websocket, but auth callback and infinite-reconnect semantics are not documented |
| Local HTTP server | `node:http` | `axum` (or `hyper`) | 0.8.9 | good | Loopback OAuth/MCP callback listeners |
| OAuth 2 | hand-rolled + `axios` | `oauth2` (+ hand-rolled discovery/DCR) | 5.0.0 | partial | PKCE, code exchange, refresh, device flow; no RFC 8414/9728/DCR |
| MCP | `@modelcontextprotocol/sdk` | `rmcp` | 3.11.0 | partial | Client+server, stdio + streamable HTTP + auth; legacy HTTP+SSE and Rayu's custom transports need `Transport` impls |
| LSP | `vscode-jsonrpc`, `vscode-languageserver-protocol` | `async-lsp` + `lsp-types` | 0.2.4 / 0.97.0 | good | Client `MainLoop` + stdio; `tower-lsp` is server-only |
| OpenTelemetry | `@opentelemetry/*` | `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp` | 0.33.1 | good | Span/metric/log exporters over gRPC/HTTP proto/JSON, headers, retry |
| Terminal QR | `qrcode` | `qrcode` | 0.15.0 | good | `QrCode::new` + `render::<unicode::Dense1x2>()`, `EcLevel::L` |
| Image decode/resize | `sharp`, `jpeg-js`, `pngjs` | `image` (+ `zune-jpeg`) | 0.25.10 / 0.5.15 | partial | PNG/JPEG/GIF/WebP; libvips-only formats and exact compressor output differ |
| Runtime validation | `zod` | `serde`/`serde_json` + `jsonschema` | 0.61.2 | good / partial | Typed boundaries + JSON Schema where a schema is actually supplied |
| NDJSON IPC | `node:net` | `tokio::net` + `tokio-util::codec::LinesCodec` | 0.7.20 | good | `LinesCodec::new_with_max_length` gives the 16 MiB frame cap |
| Unix-socket HTTP | `undici` unix option | `hyperlocal` or `hyper` + `tokio::net::UnixStream` | 0.9.1 | good | Needed only for `ANTHROPIC_UNIX_SOCKET` |
| PKCE / state | `crypto` | `sha2`, `base64`, `rand` | — | good | S256 challenge and 32-byte state |
| Secret hygiene | none | `secrecy` / `zeroize` (optional) | — | good | Tokens are read into memory only today (`kiroAuth.ts:8,15`) |

Do **not** pick: `tower-lsp` (server abstraction only,
<https://docs.rs/tower-lsp/latest/tower_lsp/>), the `anthropic` /
`anthropic-sdk-rust` crates (0.0.8 / 0.1.1, too immature for a byte-equivalence
port), or a Gemini crate for Vertex (see §2.3).

---

## 2. Dependency-by-dependency

### 2.1 `@anthropic-ai/sdk` — fit: **none** (build on reqwest)

What the code actually depends on:

- `client.beta.messages.create(params, opts)` with `betas: string[]`
  (`services/api/claude.ts:568-586,890,1563`). The SDK turns `betas` into the
  `anthropic-beta` header
  (`node_modules/@anthropic-ai/sdk/src/resources/beta/messages/messages.ts:139`). `getExtraBodyParams` duplicates the list into an
  `anthropic_beta` body field when a provider needs it there
  (`claude.ts:298-360`), and Bedrock specifically requires the body form
  (`claude.ts:1207-1212`).
- `.withResponse()` → `{ data: AsyncIterable<BetaRawMessageStreamEvent>,
  request_id, response }` (`claude.ts:1944-1960`).
- Streaming event handling: `message_start`, `content_block_start`,
  `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`,
  `input_json_delta`, `citations_delta`, `connector_text_delta`),
  `content_block_stop`, `message_delta`, `message_stop`
  (`claude.ts:2195-2310`).
- Cache/usage fields `input_tokens`, `output_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`
  (`claude.ts:2520-2521,3080-3164`).
- SDK error classes `APIError`, `APIConnectionError`, `APIUserAbortError`, and
  `headers.get(...)` for `retry-after`, `x-should-retry`,
  `anthropic-ratelimit-unified-reset`, `anthropic-ratelimit-unified-overage-disabled-reason`
  (`services/api/withRetry.ts:1-6,312-315,574-583,787-803,896-904`).

Rust shape:

- Define `ir::Request` / `ir::Response` / `ir::StreamEvent` as serde types. Keep
  unknown beta fields in an `extra: serde_json::Map<String, Value>` so an
  unrecognized provider field survives round-trips.
- Add `anthropic-beta: <comma-joined>` as a normal header; for Bedrock also
  serialize `anthropic_beta` into the body.
- Implement `reqwest::Response::bytes_stream()` → `eventsource-stream` → your
  own dispatcher, not the SDK's.
- Represent SDK errors as one `ApiError { status: Option<u16>, headers, kind:
  Connection | Abort | Api }`. Retry logic keys off this enum, not `instanceof`.

Traps:

- **The SDK ignores SSE frames whose `event:` is not one of its known names**
  (`node_modules/@anthropic-ai/sdk/src/core/streaming.ts:51-110`). A port that
  dispatches on the `data` JSON `type` alone will accept frames the original
  silently drops. Decide per surface: Claude API wants the event name; the
  bridge stream explicitly drops `data:`-only frames
  (`src/cli/transports/SSETransport.ts:386-396`).
- **Beta headers differ per provider.** `claude.ts:1207-1212` puts the
  tool-search beta in the body for Bedrock; `claude.ts:1631-1674` adds 1M
  context/structured-output betas dynamically. Do not hardcode a header list.
- **`apiKey` must be null for non-first-party Anthropic auth**, otherwise the
  SDK falls back to `ANTHROPIC_API_KEY` and sends a first-party key to a
  third-party host (`anthropicMessagesClient.ts:221-243`). In Rust there is no
  env fallback; make credential presence explicit per provider.
- **First-party-only decorations** (`ANTHROPIC_CUSTOM_HEADERS`,
  `X-Claude-Code-Session-Id`, `x-client-request-id`) are gated
  (`anthropicTransport.ts:118-165`). A `null` header in the SDK means "delete".
  In reqwest, build a fresh `HeaderMap` per request rather than inheriting.

### 2.2 `openai` — fit: **partial** (`async-openai` 0.43.0)

Verified capabilities:

- `Client::chat()` and `Client::responses()` exist
  (<https://docs.rs/async-openai/latest/async_openai/struct.Client.html>).
- `Chat::create` rejects `stream: true`; `Chat::create_stream` returns
  `ChatCompletionResponseStream`, documented as "a parsed SSE stream until a
  `[DONE]` is received"
  (<https://raw.githubusercontent.com/64bit/async-openai/main/async-openai/src/chat.rs>).
- `Responses::create(CreateResponse) -> Response` and
  `Responses::create_stream -> ResponseStream`, POSTing `/responses`
  (<https://raw.githubusercontent.com/64bit/async-openai/main/async-openai/src/responses/responses_.rs>).
- Feature gates `chat-completion` and `responses`
  (<https://raw.githubusercontent.com/64bit/async-openai/main/async-openai/src/lib.rs>).

Use it only if you accept its typed request/response model. What Rayu needs
that the crate does not decide for you:

- Request translation is Rayu-owned: tool-result ordering, image parts, Kimi
  `chat_template_kwargs`, `max_completion_tokens`, temperature suppression
  (`openaiAdapter.ts:117-320`).
- Response translation is Rayu-owned: reasoning extraction from
  `reasoning_content` / `reasoning` / `reasoning_details`, inline
  ` thinking…</think>` splitting, usage splitting
  (`openaiAdapter.ts:338-390,401-432,519-624,626-771`).
- Responses-specific invariants: `store: false` (`openaiResponsesAdapter.ts:211-216`),
  `strict: false` tools (`:218-230`), `include: ["reasoning.encrypted_content"]`
  and replay of reasoning items through the thinking signature
  (`:86-101,144-148,231-237,520-540`), usage only on `response.completed`
  (`:542-550`), unknown events ignored (`:567-572`).

Traps:

- **Typed structs vs forward compatibility.** Rayu's adapters intentionally
  operate on `Record<string, unknown>` and ignore unknown fields
  (`openaiAdapter.ts:70-80`; `openaiResponsesAdapter.ts:47-61,567-572`). If
  `async-openai` drops unknown fields on serialize/deserialize, an
  OpenAI-compatible provider's vendor extension will disappear. Whether it
  preserves them is **UNVERIFIED**; if you need pass-through, keep your own
  `serde_json::Value` request/response path.
- **Streaming is not an async-iterator you can resume.** Rayu's adapter returns
  a lazy hybrid thenable so the streaming call site never fires a wasted
  non-streaming request (`openaiAdapter.ts:1459-1486`;
  `openaiResponsesAdapter.ts:674-695`). In Rust, expose two explicit methods
  (`create`, `create_stream`); do not emulate by eagerly sending both.
- **Key rotation happens outside the SDK.** See §2.6 and §3.3.
- **Errors are normalized to Anthropic shapes** before retry
  (`openaiAdapter.ts:1115-1138`; `openaiResponsesAdapter.ts:600-619`). Rust
  needs the same single error enum; `async-openai`'s `OpenAIError` is not
  enough because it lacks the `headers.get("retry-after")` contract used by
  `withRetry.ts:574-583`.

### 2.3 `@google/genai` — fit: **none in practice**

There is no live import. Vertex GenAI is a raw POST to
`https://{host}/v1beta1/projects/{project}/locations/{region}/publishers/google/models/{model}:generateContent|:streamGenerateContent`
with `Authorization: Bearer`, `x-goog-user-project`
(`gemini/vertexGenaiClient.ts:17,87-115`). Login-with-Gemini Code Assist is a
raw POST to the `v1internal` endpoint with `alt=sse`
(`gemini/codeAssistClient.ts:334-379`).

Therefore: implement this as `reqwest` + `serde_json` using the existing
translation in `gemini/genaiTranslate.ts`. Community crates do not close the
gap: `gemini-rust` 2.1.0 documents the Gemini developer API and tools but not
Vertex (<https://docs.rs/gemini-rust/latest/gemini_rust/>);
`google-cloud-aiplatform-v1` 1.19.0 exposes `PredictionService` but does not
document `generateContent`/streaming
(<https://docs.rs/google-cloud-aiplatform-v1/latest/google_cloud_aiplatform_v1/>).

Traps to preserve:

- **Tool-schema sanitization** to Gemini's OpenAPI subset
  (`genaiTranslate.ts:160-221`). Serde will happily emit `$schema`,
  `additionalProperties`, `oneOf`, `const`; Gemini 400s on those.
- **`thoughtSignature` capture/replay**, keyed by tool-call id
  (`genaiTranslate.ts:37-47,94-104,276-287`). Dropping it produces
  "Function call is missing a thought_signature".
- **Thought parts must be checked before text parts** because they also carry
  `text` (`genaiTranslate.ts:269-275,335-352`).
- **Two different SSE parsers.** Vertex uses the frame parser
  (`parseSSEResponses`, but line-based: it splits on `\n` and takes `data:`
  lines, `codeAssistClient.ts:260-290`). Code Assist does the same. Neither
  supports multi-line `data:` the way the OpenAI SDK does.

### 2.4 AWS Bedrock + event-stream + SigV4 — fit: **good**

Verified:

- `aws-sdk-bedrockruntime` 1.156.0 has operations `invoke_model`,
  `invoke_model_with_response_stream`, `count_tokens`
  (<https://docs.rs/aws-sdk-bedrockruntime/latest/aws_sdk_bedrockruntime/operation/index.html>),
  and streaming types `ResponseStream`, `PayloadPart`
  (<https://docs.rs/aws-sdk-bedrockruntime/latest/aws_sdk_bedrockruntime/types/index.html>).
- `aws-smithy-eventstream` 0.61.6 `MessageFrameDecoder` buffers partial frames
  (`DecodedFrame::Incomplete`) and validates both the prelude and message CRC
  (`PreludeChecksumMismatch`, `MessageChecksumMismatch`)
  (<https://raw.githubusercontent.com/smithy-lang/smithy-rs/main/rust-runtime/aws-smithy-eventstream/src/frame.rs>).
  It imposes **no maximum frame size**.
- `aws-config` 1.13.3 provides env/profile/IMDS/ECS/SSO/web-identity/STS/process
  credential providers and a default chain
  (<https://docs.rs/aws-config/latest/aws_config/>).
- `aws-sigv4` 1.6.6 signs HTTP requests and event-stream messages
  (<https://docs.rs/aws-sigv4/latest/aws_sigv4/>).

How Rayu uses it:

- Claude-on-Bedrock is **bearer-token**, not SigV4: the fetch wrapper sets
  `Authorization: Bearer <Bedrock API key>` and deletes `x-api-key`,
  `anthropic-version`, `anthropic-beta`
  (`services/api/bedrockAnthropic.ts:190-206`). It rewrites `/v1/messages` to
  `/model/{modelId}/invoke[-with-response-stream]`, adds
  `anthropic_version: "bedrock-2023-05-31"`, drops `model` and `stream` from the
  body, validates the rewritten host, and forces `redirect: 'error'`
  (`bedrockAnthropic.ts:48-99,169-220`).
- Event-stream payloads are base64 JSON in a `bytes` field; each decoded object
  is re-emitted as `event: <type>\ndata: <json>\n\n`
  (`bedrockAnthropic.ts:108-147`).
- Control plane uses `ListInferenceProfiles`
  (`utils/model/bedrock.ts:26-70`), STS `GetCallerIdentity`
  (`utils/aws.ts:50-54`), and `CountTokens`
  (`services/tokenEstimation.ts:472-523`).

Traps:

- **Rayu caps a frame at 4 MiB** (`services/api/awsEventStream.ts:19,129-131`);
  `MessageFrameDecoder` does not. Add the cap or a corrupt/hostile stream can
  drive unbounded buffering.
- **Rayu re-encodes to SSE text**, not to a typed stream. Keeping that boundary
  lets one parser feed every Anthropic-Messages path. In Rust, either decode
  frames into owned `ir::StreamEvent` values or produce a `Stream<Item =
  Bytes>` of the synthetic SSE; the former is cleaner but must reproduce the
  "skip undecodable frame" behavior (`bedrockAnthropic.ts:121-131`).
- **Non-streaming and error responses are already Anthropic JSON** and must be
  passed through untouched (`bedrockAnthropic.ts:208-212`).
- **The model id must not be percent-encoded.** Bedrock ids contain `.` and
  `:`; `encodeURIComponent` would escape the colon and 404
  (`bedrockAnthropic.ts:74-80`).
- **`AWS_BEDROCK_BASE_URL` / `ANTHROPIC_BEDROCK_BASE_URL` override** changes the
  allowed host; the check is exact-host (`bedrockAnthropic.ts:48-63`).
- **Kiro/CodeWhisperer is a different payload schema on the same framing**
  (`kiro/eventStream.ts:1-6,20-30`), and Kiro auth is a bearer token from a
  local SQLite store, not SigV4 (`kiro/kiroAuth.ts:190-355,365-395`).

### 2.5 `google-auth-library` — fit: **partial**

Rayu's contract (`gemini/vertexAuth.ts`):

- Prefer the interactive OAuth token, then ADC (`:88-98`).
- Cache until 5 minutes before expiry (`:24,105-115`).
- Bound credential probes at 5 s so the GCE metadata server cannot hang startup
  (`:29-31,47-54,63-75`).
- Project precedence `GOOGLE_CLOUD_PROJECT` → `ANTHROPIC_VERTEX_PROJECT_ID` →
  `GCLOUD_PROJECT`/`GCP_PROJECT` → ADC project (`:172-206`).

Rust options:

- `yup-oauth2` 12.1.2: `ApplicationDefaultCredentialsAuthenticator`,
  `ServiceAccountAuthenticator`, scopes, token caching/refresh
  (<https://docs.rs/yup-oauth2/latest/yup_oauth2/>). Closest single-crate fit.
- `google-cloud-auth` 1.19.0: `credentials` module with service-account, user,
  metadata (MDS) and external-account sources
  (<https://docs.rs/google-cloud-auth/latest/google_cloud_auth/credentials/index.html>).
  It does not document one ADC entry point; `Builder` constructs credentials.

Traps:

- Neither crate documents Rayu's **source order** (interactive first, ADC
  second) or the **5 s probe timeout**. Implement both explicitly.
- ADC on a laptop with no credentials may query the metadata server; without a
  timeout the first request can hang for many seconds. `vertexAuth.ts:29-31`
  exists precisely for this.
- `expiry_date` may be absent; Rayu defaults to a 1 h TTL
  (`vertexAuth.ts:27,67-71`).

### 2.6 HTTP stack: `axios`, `undici`, `https-proxy-agent` — fit: **partial**

`reqwest` 0.13.5 verified surface:

- `timeout` = total request deadline; `connect_timeout`; `read_timeout` per
  read (<https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html>).
- `proxy(Proxy)` disables automatic system proxy; system proxies are enabled by
  default from `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`
  (<https://docs.rs/reqwest/latest/reqwest/>).
- `NoProxy::from_env()` checks `NO_PROXY` then `no_proxy`; supports IPv4/IPv6,
  CIDR, `*`, and domain suffix with optional leading dot
  (<https://docs.rs/reqwest/latest/reqwest/struct.NoProxy.html>). **Port-based
  matching is not documented.**
- `redirect(Policy)`: `none()`, `limited(n)`, `custom(...)`; `Attempt` exposes
  `follow()`, `stop()`, `error(...)`
  (<https://docs.rs/reqwest/latest/reqwest/redirect/struct.Policy.html>).
- `identity(Identity)` for client certs, `tls_certs_merge` /
  `tls_certs_only` for roots, `tls_danger_accept_invalid_certs`
  (ClientBuilder page above).
- `http1_only()`, `http2_prior_knowledge()` (requires `http2`, default on);
  `pool_idle_timeout` default 90 s.
- Default TLS is rustls with `rustls-platform-verifier`
  (<https://docs.rs/crate/reqwest/latest/features>).

Rayu behaviors to preserve:

| Behavior | TS source | Rust note |
|---|---|---|
| Proxy env preference lowercase then uppercase | `utils/proxy.ts:64-66` | reqwest checks both; verify precedence if it matters |
| `NO_PROXY` supports host, `.suffix`, `*`, `host:port`, IP | `utils/proxy.ts:88-129` | reqwest has no documented port rule; implement a pre-check and `no_proxy()` per request or a custom `NoProxy` |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS` skips local DNS | `utils/proxy.ts:151-158` | No direct reqwest switch; use a custom DNS resolver or a CONNECT-only path |
| `disableKeepAlive()` sticky after ECONNRESET/EPIPE | `utils/proxy.ts:27-35`; `withRetry.ts:109-115,215-227` | Build a new `Client` with `pool_max_idle_per_host(0)` / `pool_idle_timeout(None)` |
| `redirect: 'error'` for gateway + Bedrock rewrite | `anthropicMessagesClient.ts:180-187`; `bedrockAnthropic.ts:199-206` | `Policy::custom(|a| a.error(...))`. `Policy::none()` "does not follow", which is **not documented as an error**; do not assume it matches |
| `ANTHROPIC_UNIX_SOCKET` tunnels only the Anthropic API | `utils/proxy.ts:300-305` | `hyperlocal` `UnixConnector` or a `hyper` UDS connector (`https://docs.rs/hyperlocal/latest/hyperlocal/`) |
| mTLS from `CLAUDE_CODE_CLIENT_CERT/KEY/PASSPHRASE` | `utils/mtls.ts:23-95` | `Identity::from_pem`; keep a separate client when set |
| TLS roots: bundled Mozilla + `NODE_EXTRA_CA_CERTS`, or system with `--use-system-ca` | `utils/caCerts.ts:6-104` | See §3.4 |

### 2.7 `ws`, `socket.io-client`, `express` — fit: **good / partial / not needed**

- Telegram is **not** WebSocket. It is HTTPS long-poll
  (`telegram/telegramApi.ts:6,256-269`, timeout 50 s) plus hosted relay
  (`telegram/telegramTransport.ts:22-54`). `reqwest` covers it.
- The Claude Code bridge reads SSE and posts events; it uses a custom SSE
  parser, not `ws` (`cli/transports/SSETransport.ts:149-415`); the web bridge
  uses socket.io websocket-only
  (`webBridge/client/client.ts:247-268`). `ws` appears in
  `utils/mcpWebSocketTransport.ts`, `services/voiceStreamSTT.ts`,
  `vscode/host/ide/*`, and in `cli/transports/WebSocketTransport.ts` via
  `globalThis.WebSocket` (`:162`). VS Code is out of scope (ADR-004).
- WebSocket in Rust: `tokio-tungstenite` 0.30.0, `connect_async` /
  `connect_async_tls_with_config`, `Connector::{Plain, NativeTls, Rustls}`
  (<https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/>). No proxy
  support is documented; implement CONNECT manually if `HTTPS_PROXY` must apply.
- socket.io in Rust: `rust_socketio` 0.6.0 supports `namespace("/x")`, and
  websocket with long-polling fallback
  (<https://docs.rs/rust_socketio/latest/rust_socketio/>). Rayu forces
  `transports: ["websocket"]`, a custom `path`, an auth **callback that
  refreshes the token per connect**, infinite reconnect with 1 s→30 s backoff,
  and reconnects on token expiry (`webBridge/client/client.ts:247-268,457-467,
  528,649-667`). The crate documents neither the auth callback nor reconnect
  policy; exact parity is **UNVERIFIED** and may require implementing Engine.IO
  v4 framing yourself. This is the highest-risk third-party WS dependency.
- `express` does not exist here. The OAuth listener is
  `node:http.createServer` bound to `localhost`, random port, path-checked
  callback, CSRF `state` comparison, and kept open only long enough to redirect
  (`services/oauth/authCodeListener.ts:35,44-58,133-174,198-208`). Use `axum`
  0.8.9 or `hyper` directly.

### 2.8 `@modelcontextprotocol/sdk` — fit: **partial** (`rmcp` 3.11.0)

`rmcp` verified:

- Client transports: `transport::child_process::TokioChildProcess` (stdio) and
  `transport::streamable_http_client::StreamableHttpClientTransport`.
- Server: `transport::io::stdio`, `StreamableHttpService`.
- Custom transports implement `transport::Transport`.
- Features: `client`, `server`, `auth`, `auth-enterprise-managed`,
  `transport-io`, `transport-child-process`, `transport-streamable-http-client`,
  `transport-streamable-http-client-reqwest`, `transport-streamable-http-server`,
  `reqwest` / `reqwest-native-tls` / `reqwest-tls-no-provider`.
- The legacy **HTTP+SSE** client transport is not listed as a separate
  transport (`sse-stream` is an optional dependency).
  Source: <https://docs.rs/rmcp/latest/rmcp/>.

Rayu's MCP surface is larger than the default client:

- Transports: `stdio`, `sse`, `http`, `ws-ide`, `sse-ide`, in-process linked
  pair, and an SDK-control transport
  (`services/mcp/client.ts:9-20,82,130,534,597,626,658,707,785,803-813,821`).
  Only `stdio` and streamable HTTP map to rmcp out of the box.
- OAuth provider implements the SDK's `OAuthClientProvider` with secure
  storage, dynamic client registration, CIMD URL client ids, step-up scope
  handling, XAA/ID-JAG refresh
  (`services/mcp/auth.ts:1556-1660,1697-1724,2036-2141,2442-2462`). rmcp's
  `auth` feature is a different trait surface; expect to adapt or keep the
  OAuth flow hand-rolled.
- Wire rules the port must keep, from the MCP spec:
  - Streamable HTTP POST `Accept` must list **both** `application/json` and
    `text/event-stream`
    (<https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>).
    Rayu enforces it explicitly (`client.ts:387-395,745-751`).
  - `Mcp-Session-Id` is returned at initialize and must be sent on every later
    request; a 404 means start a new session. Rayu clears the connection cache
    on 404 / JSON-RPC `-32001` / `-32000 "Connection closed"`
    (`client.ts:3029-3062`).
  - `MCP-Protocol-Version` is required on subsequent HTTP requests (spec
    above).
  - SSE resumption uses `Last-Event-ID` (spec above). `reqwest-eventsource`
    0.6.0 documents reconnect/retry but **not** `Last-Event-ID`
    (<https://docs.rs/reqwest-eventsource/latest/reqwest_eventsource/>).
  - stdio is newline-delimited JSON with no embedded newlines; stderr is
    logging only (spec above). Rayu pipes stderr and caps accumulation at
    64 MiB (`client.ts:818-858`).
  - OAuth: RFC 9728 protected-resource metadata, RFC 8414 AS metadata, RFC 7591
    dynamic registration, PKCE, RFC 8707 `resource` parameter, audience
    validation
    (<https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>).
- Lifecycle differences: Rayu sends SIGINT then escalates within ~500 ms before
  killing a stdio child (`client.ts:1279-1305`). rmcp's child process API may
  only kill; implement the escalation if parity matters.

Recommendation: use `rmcp` for the stdio and streamable-HTTP transports and
JSON-RPC plumbing, but implement the custom transports as `rmcp::transport::Transport`
and keep the OAuth provider logic in the port's own module. Budget adapter work;
this is not a drop-in.

### 2.9 `vscode-jsonrpc`, `vscode-languageserver-protocol` — fit: **good**

`async-lsp` 0.2.4 provides a **client** (`LanguageClient`, `ClientSocket`,
`MainLoop`, `Router`) and stdio utilities (`stdio` feature), plus JSON-RPC/LSP
message and error types
(<https://docs.rs/async-lsp/latest/async_lsp/>). `lsp-types` 0.97.0 provides
`InitializeParams`, `InitializeResult`, `ServerCapabilities`, request and
notification modules, LSP 3.17-era features
(<https://docs.rs/lsp-types/latest/lsp_types/>).

Rayu behaviors (`services/lsp/LSPClient.ts`):

- Spawn with `stdio: ['pipe','pipe','pipe']`, wait for the `spawn` event before
  touching streams, capture stderr (`:98-141`).
- JSON-RPC over stdio via `StreamMessageReader`/`StreamMessageWriter`
  (`:181-183`). That is `Content-Length` framing; `async-lsp`'s stdio feature
  provides it.
- Enable verbose trace with `$/setTrace` and catch failure (`:216-226`).
- Queue notification/request handlers registered before connect (`:63-71,
  229-244,337-370`). In Rust, register after the `MainLoop` exists or buffer
  them.
- No per-request timeout. A hung server hangs the caller; preserve that (do not
  silently add a timeout).
- Shutdown: `shutdown` request, `exit` notification, dispose, then kill process
  (`:373-445`).

Traps: `tower-lsp` is a server abstraction; do not use it for a client. Keep
the process-crash semantics: a non-zero exit during operation marks the client
failed and calls `onCrash` (`LSPClient.ts:156-167`), while an intentional stop
must not log spurious errors (`:62,144-154,175-177`).

### 2.10 `@opentelemetry/*` — fit: **good / partial**

`opentelemetry-otlp` 0.33.1:

- Span/metric/log exporters; gRPC (`tonic`), HTTP protobuf, HTTP JSON.
- Protocol selected by `grpc`, `http/protobuf`, `http/json`.
- Headers via `with_headers` (HTTP) / `with_metadata` (gRPC); env
  `OTEL_EXPORTER_OTLP_HEADERS` and signal-specific equivalents.
- TLS: `tls-ring`/`tls-aws-lc`/provider-agnostic; roots `tls-roots` or
  `tls-webpki-roots`; HTTP via `reqwest-rustls` or a custom client.
- Retry with exponential backoff is always enabled.
  Source: <https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/>.
- `opentelemetry_sdk` 0.33.1: `SdkTracerProvider`, `BatchSpanProcessor`,
  metrics `PeriodicReader`, `Resource`, `shutdown()`
  (<https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/>).

Rayu behavior (`utils/telemetry/instrumentation.ts`):

- One protocol variant per signal, selected by env: `grpc`,
  `http/protobuf`, `http/json` (`:159-191,220-260,274-300`).
- `OTEL_EXPORTER_OTLP_ENDPOINT` plus signal-specific overrides; custom
  `getOTLPExporterConfig` (`:768-800`).
- Metrics temporality forced to `delta` unless set (`:114-115`).
- Separate beta tracing path using `BETA_TRACING_ENDPOINT` and HTTP
  `/v1/traces`, `/v1/logs` with `BatchSpanProcessor` /
  `BatchLogRecordProcessor` (`:351-410`).
- BigQuery metrics exporter every 5 minutes (`:320-333`) has **no**
  OpenTelemetry-Rust equivalent; port it as a custom `MetricExporter` or a
  periodic job if it must be kept.

Traps: the env-var contract (`OTEL_*`, `ANT_OTEL_*`) is part of drop-in
compatibility (ADR-006). Do not replace it with a Rust-only config file.

### 2.11 `qrcode`, `sharp`, `jpeg-js` — fit: **good / partial**

QR:

- Rayu renders `{ type: 'utf8', errorCorrectionLevel: 'L' }`
  (`commands/telegram-bot/telegram-bot.tsx:1,163,531`;
  `bridge/bridgeUI.ts:2,31-32`).
- `qrcode` 0.15.0: `QrCode::new`, `render::<unicode::Dense1x2>()`,
  `EcLevel::L`
  (<https://docs.rs/qrcode/latest/qrcode/>).
- Trap: the exact glyph matrix, quiet zone and module scaling will differ from
  npm `qrcode`'s `toString({type:'utf8'})`. If any recorded case captures the
  QR block, byte-for-byte equivalence fails (ADR-005). Either reproduce the npm
  renderer bit-for-bit or exempt those frames. **Flag before porting.**

Images:

- `sharp` is libvips: format detection, EXIF orientation, ICC, AVIF/TIFF/SVG,
  and its own resize kernels. Rayu uses it for metadata, PNG palette
  compression, JPEG quality loops, and resizing
  (`utils/imageResizer.ts:182-374`), with limits 5 MB base64 / 2000×2000 /
  3.75 MB raw (`constants/apiLimits.ts:22,29,42-43`).
- `image` 0.25.10 supports PNG/GIF/WebP/JPEG (`png`, `gif`, `image-webp`,
  `zune-jpeg`) and `imageops`
  (<https://docs.rs/image/latest/image/>).
- `jpeg-js` → `zune-jpeg` 0.5.15 decodes baseline JPEG to RGBA; progressive and
  EXIF orientation are not documented
  (<https://docs.rs/zune-jpeg/latest/zune_jpeg/>).
- `pngjs` → `image` PNG decode; `terminalImage.ts:5-6,19-22` only needs RGBA
  pixels.

Traps: exact compressed byte size and pixel output will differ, so the
"compress until under 5 MB" loop must be re-derived, not assumed equivalent.
Formats libvips handles but `image` does not (AVIF, TIFF, SVG) will fail; decide
whether to drop support or add `ravif`/`resvg`/`tiff` decoders.

### 2.12 `zod` — fit: **good (serde) / partial (JSON Schema)**

Use serde at typed boundaries, and `jsonschema` 0.61.2 where a JSON Schema is
actually supplied. `jsonschema` supports drafts 2020-12, 2019-09, 7, 6, 4, with
varying keyword coverage
(<https://docs.rs/jsonschema/latest/jsonschema/>).

Mapping notes:

- Provider payloads are **not** schema-validated today; they are permissive
  object walks (`openaiAdapter.ts:70-80`, `openaiResponsesAdapter.ts:47-61`).
  Do not tighten them into `deny_unknown_fields`; that would reject vendor
  extensions the TS code tolerates.
- Config/back-end shapes that *are* zod-validated today:
  `services/api/bootstrap.ts:8-20,93` (bootstrap response),
  `services/mcp/config.ts:602,1065,1290` (server config),
  `services/mcp/xaa.ts:102-113,285,387` (token exchange).
  Port these with explicit `serde` structs plus `#[serde(flatten)] extra` where
  zod uses `.passthrough()`.
- The IPC protocol does **manual** structural validation, not zod
  (`ipc/protocol.ts:112-173`). Keep it manual so the rejection reasons stay
  identical (`oversize`, `malformed-json`, `not-an-object`,
  `version-mismatch`, `unknown-kind`, `missing-fields`).

---

## 3. Cross-cutting semantic traps

### 3.1 SSE parsing

The original has **four** SSE readers with different strictness. Port each
one explicitly; do not assume one parser fits all.

| Reader | Framing | Multi-line `data:` | Comments | `[DONE]` | Missing `event:` | Source |
|---|---|---|---|---|---|---|
| Anthropic SDK | line decoder `\r\n`/`\r`/`\n`, blank-line frame | yes, joined with `\n` | ignored | not handled | frame ignored unless known event | `node_modules/@anthropic-ai/sdk/src/core/streaming.ts:18-19,51-110`; `internal/decoders/line.ts:12-16` |
| OpenAI SDK | same | yes, joined with `\n` | ignored | stops stream when `data` starts `[DONE]` | yields `data` JSON | `node_modules/openai/src/core/streaming.ts:53,236-249,288-330` |
| Claude Code bridge | blank-line frame, `\n\n` | yes, joined with `\n` | treated as liveness signal, not emitted | none | `data:` without `event:` is logged and dropped | `src/cli/transports/SSETransport.ts:58-116,386-396` |
| Gemini (Vertex + Code Assist) | line-based, `\n` | no | n/a | skipped | n/a | `services/api/gemini/codeAssistClient.ts:260-290` |

Spec details that matter:

- One optional space after `:` is stripped (OpenAI `SSEDecoder` above; Rayu
  `SSETransport.ts:88-92`).
- `data:` values are concatenated with `\n`; the OpenAI SDK uses
  `data.join('\n')` (`streaming.ts:307-310`). `eventsource-stream` appends `\n`
  then pops the trailing one (`event_stream.rs::EventBuilder::add`/`dispatch`),
  yielding the same value.
- `eventsource-stream` **suppresses data-less events** and defaults the event
  name to `"message"`
  (<https://raw.githubusercontent.com/jpopesculian/eventsource-stream/main/src/event_stream.rs>).
  That is incompatible with the bridge's comment-as-liveness behavior; if you
  use the crate there, wrap the raw byte stream and keep comments, or hand-roll.
- `eventsource-stream` also does not stop at `[DONE]`; layer that per surface.
- Bedrock re-emits `event: <type>\ndata: <json>\n\n`
  (`bedrockAnthropic.ts:132-139`); that is the only place Rayu synthesizes SSE.

### 3.2 Streaming JSON reassembly and tool arguments

- **Anthropic**: `input_json_delta.partial_json` is **appended** to
  `contentBlock.input` while it is a string
  (`claude.ts:2215-2242`). Do not parse on each delta.
- **OpenAI chat**: tool calls are keyed by the stable `index`, not `id`; `id`
  and `name` arrive only in the first chunk
  (`openaiAdapter.ts:716-746`). A later chunk with only `arguments` must append
  to the same block.
- **OpenAI Responses**: `response.function_call_arguments.delta` is appended to
  the open function-call block (`openaiResponsesAdapter.ts:507-518`); the final
  item may also carry `arguments` (`:329-337`). Reasoning items must be
  replayed verbatim via the IR thinking signature
  (`:86-101,144-148,520-540`).
- **Gemini**: `functionCall.args` arrives whole; Rayu serializes it into a
  single `input_json_delta` (`genaiTranslate.ts:368-392`).
- **Final parse and repair are not trivial.** At message normalization, a
  string `input` is parsed; if malformed, a bounded, staged repair runs:
  strip markdown fence → extract outermost JSON from prose → escape raw control
  characters inside strings → remove trailing commas → close truncated
  structures, re-parsing after every stage, with an input-size cap and an
  unclosed-depth cap (`utils/toolInputRepair.ts:286-354`; call site
  `utils/messages.ts:2705-2723`). A Rust port that just calls `serde_json::from_str`
  will change behavior for non-Claude providers, which routinely emit fenced,
  newline-containing, trailing-comma, or truncated arguments.

### 3.3 Retry/backoff and key rotation

Retry policy (`services/api/withRetry.ts`):

- Default max retries 10, override `CLAUDE_CODE_MAX_RETRIES`
  (`:49,840-848`); loop runs `maxRetries + 1` attempts (`:186`).
- Delay: `min(500 ms * 2^(attempt-1), maxDelayMs)` + 0–25 % jitter
  (`:52,585-603`). `retry-after` seconds bypass the cap (`:590-595`).
- Retryable: `APIConnectionError`, 408, 409, 429, 5xx, 401 (after key refresh),
  403 "OAuth token has been revoked", and `x-should-retry: true`
  (`:751-838`). `x-should-retry: false` is honored except Ant 5xx
  (`:796-803`).
- Terminal, not retried: Rayu credit limit, daily turn cap, weekly/session
  window limits (`:265-296`). These are 429s but must not sleep for a
  period-length `Retry-After`.
- Background query sources do not retry 529/429; foreground sources do
  (`:59-86,353-379`).
- 529: after 3 consecutive, fall back to `fallbackModel` if set, else surface a
  capacity error (`:51,382-420`).
- Fast-mode 429/529: short `Retry-After` waits, long/unknown enters cooldown
  (`:304-351`).
- Stale keep-alive: on `ECONNRESET`/`EPIPE`, disable keep-alive before retrying
  (`:109-115,215-227`).
- Unattended persistent retry: 429/529 loop with 5 min max backoff, 6 h reset
  cap, 30 s heartbeat yields (`:93-101,424-427,488-518,532-567`).
- `Retry-After` on a transient Rayu concurrency denial is ignored if > 60 s
  (`:854-883`).

Rust: hand-roll this loop. `backoff`/`tokio-retry` do not model terminal
credit/window 429s, source-dependent retry, `x-should-retry`, or sticky
keep-alive disable. Keep the exact delay formula and jitter shape.

Key rotation (`services/api/keyRotation.ts`):

- Rotatable statuses are exactly `{429, 402, 401, 403}`; 404 is deliberately
  excluded (`:28-30`).
- Anthropic-compatible rotates **at the fetch layer**: rewrite `Authorization`,
  re-issue the same request, loop through keys, stick to the last successful
  key, cancel/drain the previous body (`anthropicMessagesClient.ts:98-130`).
- OpenAI-compatible rotates **at the request layer**: one client per key, same
  status set, no rotation when a custom `fetch` is supplied (dynamic token),
  sticky index, report an issue, then propagate (`openaiAdapter.ts:815-829,
  1233-1269`).
- All keys exhausted → the last error propagates to `withRetry`, which backs
  off and re-enters the loop.

Traps: a reqwest `Request` body is consumed. Keep the serialized body as
`Bytes` and rebuild the request per attempt; drain/cancel a streaming response
before rotating. Do not rotate a routed-subagent request onto the active
provider's key (`providerRegistry.ts:325-334,419-433`).

### 3.4 TLS root store, HTTP/2, timeouts, abort

**Root store.** Node (and the CLI's own helper) uses bundled Mozilla roots by
default, optionally the system store with `--use-system-ca`/`--use-openssl-ca`,
and always appends `NODE_EXTRA_CA_CERTS`
(`utils/caCerts.ts:6-19,28-104`). reqwest 0.13's default rustls backend uses
`rustls-platform-verifier`, i.e. the OS store
(<https://docs.rs/crate/reqwest/latest/features>;
<https://docs.rs/rustls-platform-verifier/latest/rustls_platform_verifier/>).
These are different trust sets.

- To match Node's default: build a rustls config with `webpki-roots` 1.0.12
  (compiled Mozilla roots,
  <https://docs.rs/webpki-roots/latest/webpki_roots/>), then merge
  `NODE_EXTRA_CA_CERTS` file contents yourself. `rustls-native-certs` 0.8.5
  loads the OS store and honors `SSL_CERT_FILE`, **not** `NODE_EXTRA_CA_CERTS`
  (<https://docs.rs/rustls-native-certs/latest/rustls_native_certs/>).
- To match `--use-system-ca`: use `rustls-platform-verifier` and still append
  `NODE_EXTRA_CA_CERTS` manually.
- Use `tls_certs_merge` to add extras onto a chosen base; `tls_certs_only`
  replaces the base. A `ca`-style replacement is what `caCerts.ts:9-10` warns
  about.

**HTTP/2.** Rayu never forces a protocol; the TypeScript runtimes' fetch
decides. reqwest 0.13 enables `http2` by default and negotiates via ALPN. Node's
`fetch`/undici path is HTTP/1.1. For byte/behavior parity and proxy
compatibility, start with `http1_only()` and only enable h2 where verified. The
exact Bun fetch behavior is **UNVERIFIED**; treat it as a variable, not a
contract.

**Timeouts.**

| Call | Timeout | Source |
|---|---|---|
| Anthropic SDK | `API_TIMEOUT_MS` or 600 s, total request | `anthropicTransport.ts:169` |
| OpenAI SDK | not set by Rayu; SDK default applies (**UNVERIFIED** exact value) | `openaiAdapter.ts:1197-1210`; `openaiResponsesAdapter.ts:626-633` |
| MCP per request | 60 s, but **GET SSE streams are excluded** | `services/mcp/client.ts:387,397-420` |
| Telegram long poll | 50 s | `telegram/telegramApi.ts:256-269` |
| OAuth token endpoint | 15 s | `services/oauth/client.ts:171-174,207-210` |
| IPC request | 10 s | `ipc/connection.ts:48,187-213` |
| LSP | none | `services/lsp/LSPClient.ts:289-314` |

**Abort propagation.** In TypeScript the `AbortSignal` is threaded into the SDK
call (`openaiAdapter.ts:1457`; `openaiResponsesAdapter.ts:676`) and checked in
the retry loop (`withRetry.ts:187-189,546`). In Rust, pass a
`CancellationToken` or abort handle into the request and `tokio::select!` it
against the response stream. Dropping the `Response`/`bytes_stream` is what
actually cancels the body; make sure the stream is dropped on abort and on
rotation, not just abandoned.

### 3.5 OAuth, PKCE, and local callbacks

- Authorization URL uses PKCE S256 and a `state` value
  (`services/oauth/client.ts:101-148`).
- Token exchange and refresh are JSON POSTs with a 15 s timeout
  (`:150-210`).
- The callback server binds `localhost`, random port, checks path and compares
  `state` before accepting the code, and holds the response open only to
  redirect (`authCodeListener.ts:44-58,133-174`).
- MCP OAuth is a different, larger flow: public client metadata
  (`token_endpoint_auth_method: "none"`, `authorization_code` +
  `refresh_token`), 32-byte state, PKCE verifier, DCR, CIMD URL client id,
  step-up scopes, and a silent XAA refresh path
  (`services/mcp/auth.ts:1597-1664,1657-1664,1697-1724,2036-2141`). Spec:
  RFC 9728 / 8414 / 7591 / 8707 and OAuth 2.1 PKCE
  (<https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>).

Rust: `oauth2` 5.0.0 covers `PkceCodeChallenge`/`PkceCodeVerifier`,
`AuthorizationCode`, `RefreshToken`, device flow, and configurable
`TokenUrl`/`AuthUrl`
(<https://docs.rs/oauth2/latest/oauth2/>). It does **not** do RFC 8414/9728
discovery, RFC 7591 registration, CIMD, or the `resource` parameter; implement
those with reqwest + serde. Keep the `state` check and the loopback-only bind.

### 3.6 Telegram, web bridge, IPC

Telegram:

- Base `https://api.telegram.org`, token in the path
  (`telegram/telegramApi.ts:6,186`).
- 429: honor `retry_after`, wait `min(30 s, retry_after)+200 ms`, retry **once**
  (`:193-200`).
- `getUpdates` long poll 50 s; failures are classified into
  `rate-limited | auth | backend-unavailable | telegram-error | network`
  (`:216-244,256-275`).
- Hosted mode routes through the backend; the cursor is the backend row id, not
  `update_id`, and advances only on a successful batch
  (`telegram/telegramTransport.ts:22-54`).
- Poll loop has its own interruptible backoff and stops on unlink
  (`telegram/telegramBridge.ts:1010-1117,1224`).

Web bridge:

- socket.io namespace + custom path; auth is a callback, not a query parameter;
  forced websocket; infinite reconnect 1 s→30 s; 20 s connect timeout; reconnect
  on token expiry (`webBridge/client/client.ts:247-268,457-467,528,649-667`).
  `rust_socketio` does not document these; **UNVERIFIED** and risky.

IPC:

- NDJSON, one JSON object per line (`ipc/protocol.ts:1-4,95-97`).
- 16 MiB frame cap; incremental splitter throws if the buffer exceeds it
  without a newline (`:44,184-207`).
- Per-session token compared in constant time; 3 auth failures close the
  connection (`:46-65`; `ipc/connection.ts:46-47,124-128`).
- Structural validation with a fixed rejection vocabulary
  (`protocol.ts:99-173`).
- Request timeout 10 s; pending promises reject on close
  (`connection.ts:48,187-253`).

Rust: `tokio::net::UnixListener/UnixStream` + `LinesCodec::new_with_max_length`
(`tokio-util` 0.7.20; `new()` has **no** limit, `max_length()` is
`usize::MAX`,
<https://docs.rs/tokio-util/latest/tokio_util/codec/struct.LinesCodec.html>).
Keep the token check constant-time (`subtle` or `ring::constant_time`). Do not
use `LinesCodec::new()`.

### 3.7 Telemetry

See §2.10. Two extra traps:

- Delta temporality is set explicitly (`instrumentation.ts:114-115`); keep it.
- The BigQuery exporter is a separate 5-minute reader
  (`instrumentation.ts:320-333`). `opentelemetry-otlp` has no BigQuery sink;
  implement a custom `MetricExporter` or a periodic job, or drop the feature
  only with an ADR.

---

## 4. Provider behavior checklist (must survive the port)

| # | Behavior | Evidence |
|---|---|---|
| 1 | Wire-format precedence: explicit override → legacy `bedrockApi` → per-model rules → kind default | `providerRegistry.ts:100-186` |
| 2 | Per-model split: Bedrock Claude→Anthropic, else OpenAI Chat; Azure Claude→Anthropic, else Responses; Vertex Claude→Anthropic, MaaS→Chat, Gemini→GenAI | `providerRegistry.ts:128-163` |
| 3 | Missing credentials ⇒ `unsupported`, never fall back to env | `providerRegistry.ts:253-308` |
| 4 | Third-party Anthropic auth pins `apiKey: null`; `custom-fetch` uses a placeholder only to satisfy the SDK | `anthropicMessagesClient.ts:221-243` |
| 5 | Bearer key list rotates at fetch layer on 429/402/401/403; sticky winner | `anthropicMessagesClient.ts:98-130` |
| 6 | Gateway + Bedrock send `redirect: 'error'` | `anthropicMessagesClient.ts:180-187`; `bedrockAnthropic.ts:199-206` |
| 7 | First-party-only headers; null out `ANTHROPIC_CUSTOM_HEADERS` for third parties | `anthropicTransport.ts:118-165` |
| 8 | 600 s Anthropic timeout, proxy/mTLS fetch options, debug logger | `anthropicTransport.ts:144-176` |
| 9 | OpenAI messages: strict tool_result-before-text ordering; assistant content `''` not null; tool images re-emitted | `openaiAdapter.ts:117-214` |
| 10 | OpenAI reasoning models: `max_completion_tokens`, no temperature | `openaiAdapter.ts:231-294` |
| 11 | Kimi `chat_template_kwargs.thinking` | `openaiAdapter.ts:310-318` |
| 12 | Usage split: DeepSeek hit/miss, OpenAI `prompt_tokens_details.cached_tokens`; cache_creation stays 0 | `openaiAdapter.ts:338-390` |
| 13 | Inline ` thinking` streaming splitter, leading-only, carry buffer flushed at EOF | `openaiAdapter.ts:519-624,752-757` |
| 14 | Tool calls keyed by `index`; input JSON appended; synthetic non-empty id if provider omits it | `openaiAdapter.ts:716-746,477-482` |
| 15 | Optional-param rejection is learned per (baseURL, model) and retried without the param | `openaiAdapter.ts:831-867,941-973` |
| 16 | Image-unsupported and image+tools 400s retried without images/tools; tool-unsupported gets actionable error | `openaiAdapter.ts:995-1095,1305-1343` |
| 17 | OpenAI errors normalized into Anthropic error classes for retry recognition | `openaiAdapter.ts:1115-1138`; `openaiResponsesAdapter.ts:600-619` |
| 18 | Responses: `store:false`, `strict:false`, reasoning replay, usage only on completed, unknown events ignored | `openaiResponsesAdapter.ts:86-101,211-237,432-594` |
| 19 | GenAI: schema allowlist, `thoughtSignature` replay, thought-before-text, functionResponse by name | `genaiTranslate.ts:160-240,37-47,269-287,302-403` |
| 20 | Bedrock: body rewrite, model unencoded in path, host allowlist, SSE re-emit, pass through non-stream/error | `bedrockAnthropic.ts:48-147,169-220` |
| 21 | AWS event-stream: CRC32 both halves, partial-frame buffering, 4 MiB cap, header type map, exception frames | `awsEventStream.ts:19,32-38,42-53,117-196` |
| 22 | Kiro: event-type semantics, tool-use accumulation across frames, metering/usage mapping, flush at EOF | `kiro/eventStream.ts:20-30,79-128,244-274` |
| 23 | Retry: formula, jitter, Retry-After, `x-should-retry`, 529 source gating/fallback, terminal credit/window 429, keep-alive disable | `withRetry.ts:49-115,186-227,265-420,574-603,751-903` |
| 24 | Key rotation status set and two rotation layers | `keyRotation.ts:28-30`; `openaiAdapter.ts:1233-1269`; `anthropicMessagesClient.ts:98-130` |
| 25 | MCP streamable HTTP: dual Accept, session id, 404 re-init, GET SSE no timeout, per-request 60 s | `services/mcp/client.ts:387-420,745-786,3029-3062`; MCP transports spec |
| 26 | MCP OAuth: DCR, PKCE, state, resource parameter, step-up | `services/mcp/auth.ts:1556-1664,2036-2141`; MCP auth spec |
| 27 | LSP: stdio, spawn handshake, trace, queued handlers, no request timeout, shutdown→exit→kill | `services/lsp/LSPClient.ts:88-254,373-445` |
| 28 | Telegram: 50 s poll, single capped 429 retry, typed poll failures, hosted cursor | `telegram/telegramApi.ts:193-275`; `telegram/telegramTransport.ts:22-54` |
| 29 | Web bridge: websocket-only, auth callback, infinite 1–30 s reconnect, token-refresh reconnect | `webBridge/client/client.ts:247-268,457-467,528,649-667` |
| 30 | IPC: NDJSON, 16 MiB cap, constant-time token, 3 auth failures, 10 s request timeout, fixed reject reasons | `ipc/protocol.ts:44-207`; `ipc/connection.ts:46-253` |
| 31 | Telemetry: per-signal protocol choice, `delta` temporality, `BETA_TRACING_ENDPOINT`, BigQuery 5 min | `utils/telemetry/instrumentation.ts:114-115,159-300,320-410,768-800` |
| 32 | Image limits and staged compression/resize | `constants/apiLimits.ts:22-43`; `utils/imageResizer.ts:169-388` |
| 33 | Terminal QR `EcLevel::L`, UTF-8 output | `commands/telegram-bot/telegram-bot.tsx:163`; `bridge/bridgeUI.ts:31-32` |

---

## 5. Unverified claims and decisions to make before porting

1. **Exact Bun/Node fetch HTTP version.** Rayu does not set it; Node's undici
   path is HTTP/1.1 in practice. reqwest negotiates h2 by default. Prefer
   `http1_only()` until a case proves h2 is required. **UNVERIFIED** for Bun.
2. **`reqwest::redirect::Policy::none()` vs `redirect: 'error'`.** The docs say
   "does not follow"; they do not say the 3xx becomes an error. Use
   `Policy::custom(|a| a.error(...))` to reproduce `redirect:'error'`
   (<https://docs.rs/reqwest/latest/reqwest/redirect/struct.Policy.html>).
3. **`async-openai` unknown-field preservation.** The crate is typed; whether
   it round-trips vendor fields is **UNVERIFIED**. If pass-through matters, keep
   a `serde_json::Value` path.
4. **`rust_socketio` auth callback + infinite reconnect.** Not documented.
   Likely a hand-rolled Engine.IO v4 client or a thin fork. **UNVERIFIED**;
   treat as the top schedule risk in `webBridge/`.
5. **`tokio-tungstenite` proxy support.** Not documented. If `HTTPS_PROXY` must
   apply to `ws`, implement CONNECT and pass a custom stream.
6. **`image` JPEG progressive / EXIF orientation.** `zune-jpeg` documents
   baseline T.81 decode and RGBA; progressive and EXIF are not documented.
   **UNVERIFIED**. Test against real pasted images before relying on it.
7. **`rmcp` legacy HTTP+SSE client.** The docs list stdio and streamable HTTP,
   not the 2024-11-05 HTTP+SSE transport; `sse-stream` is only an optional dep.
   If Rayu must keep connecting to old MCP servers (`services/mcp/client.ts:597-626`),
   write that transport yourself.
8. **QR byte equivalence.** npm `qrcode`'s UTF-8 output and the Rust `qrcode`
   renderer almost certainly differ in quiet zone/glyphs. Under ADR-005 this
   needs an explicit decision (reproduce or exempt).
9. **BigQuery exporter.** No Rust equivalent; either port as a custom exporter
   or record the omission in an ADR.
10. **OpenAI SDK default timeout.** Rayu does not set one; the exact default is
    not in the repo. Pin it from the SDK version in use before matching it.

---

## 6. Primary-source log

Crates (docs.rs/crates.io, read 2026-11-19):

- `reqwest` 0.13.5 — <https://docs.rs/reqwest/latest/reqwest/>,
  `struct.ClientBuilder.html`, `struct.NoProxy.html`, `struct.Proxy.html`,
  `redirect/struct.Policy.html`, <https://docs.rs/crate/reqwest/latest/features>
- `eventsource-stream` 0.2.3 — <https://docs.rs/eventsource-stream/latest/eventsource_stream/>,
  parser sources under <https://github.com/jpopesculian/eventsource-stream>
- `reqwest-eventsource` 0.6.0 — <https://docs.rs/reqwest-eventsource/latest/reqwest_eventsource/>
- `async-openai` 0.43.0 — <https://docs.rs/async-openai/latest/async_openai/>,
  `struct.Client.html`, and `src/chat.rs`, `src/responses/responses_.rs`,
  `src/lib.rs` in <https://github.com/64bit/async-openai>
- `aws-smithy-eventstream` 0.61.6 —
  <https://docs.rs/aws-smithy-eventstream/latest/aws_smithy_eventstream/>,
  `frame/index.html`, and `src/frame.rs` in
  <https://github.com/smithy-lang/smithy-rs>
- `aws-sdk-bedrockruntime` 1.156.0 —
  <https://docs.rs/aws-sdk-bedrockruntime/latest/aws_sdk_bedrockruntime/>,
  `operation/index.html`, `types/index.html`
- `aws-config` 1.13.3 — <https://docs.rs/aws-config/latest/aws_config/>
- `aws-sigv4` 1.6.6 — <https://docs.rs/aws-sigv4/latest/aws_sigv4/>
- `yup-oauth2` 12.1.2 — <https://docs.rs/yup-oauth2/latest/yup_oauth2/>
- `google-cloud-auth` 1.19.0 —
  <https://docs.rs/google-cloud-auth/latest/google_cloud_auth/credentials/index.html>
- `oauth2` 5.0.0 — <https://docs.rs/oauth2/latest/oauth2/>
- `rmcp` 3.11.0 — <https://docs.rs/rmcp/latest/rmcp/>
- `async-lsp` 0.2.4 — <https://docs.rs/async-lsp/latest/async_lsp/>
- `lsp-types` 0.97.0 — <https://docs.rs/lsp-types/latest/lsp_types/>
- `tower-lsp` 0.20.0 (server only) — <https://docs.rs/tower-lsp/latest/tower_lsp/>
- `opentelemetry-otlp` 0.33.1 —
  <https://docs.rs/opentelemetry-otlp/latest/opentelemetry_otlp/>
- `opentelemetry_sdk` 0.33.1 —
  <https://docs.rs/opentelemetry_sdk/latest/opentelemetry_sdk/>
- `qrcode` 0.15.0 — <https://docs.rs/qrcode/latest/qrcode/>
- `image` 0.25.10 — <https://docs.rs/image/latest/image/>
- `zune-jpeg` 0.5.15 — <https://docs.rs/zune-jpeg/latest/zune_jpeg/>
- `jsonschema` 0.61.2 — <https://docs.rs/jsonschema/latest/jsonschema/>
- `tokio-util` 0.7.20 —
  <https://docs.rs/tokio-util/latest/tokio_util/codec/struct.LinesCodec.html>
- `tokio-tungstenite` 0.30.0 —
  <https://docs.rs/tokio-tungstenite/latest/tokio_tungstenite/>
- `rust_socketio` 0.6.0 — <https://docs.rs/rust_socketio/latest/rust_socketio/>
- `axum` 0.8.9 — <https://docs.rs/axum/latest/axum/>
- `hyperlocal` 0.9.1 — <https://docs.rs/hyperlocal/latest/hyperlocal/>
- `rustls-platform-verifier` 0.7.1 —
  <https://docs.rs/rustls-platform-verifier/latest/rustls_platform_verifier/>
- `webpki-roots` 1.0.12 — <https://docs.rs/webpki-roots/latest/webpki_roots/>
- `rustls-native-certs` 0.8.5 —
  <https://docs.rs/rustls-native-certs/latest/rustls_native_certs/>
- `gemini-rust` 2.1.0 (developer API only) —
  <https://docs.rs/gemini-rust/latest/gemini_rust/>
- `google-cloud-aiplatform-v1` 1.19.0 (partial Vertex) —
  <https://docs.rs/google-cloud-aiplatform-v1/latest/google_cloud_aiplatform_v1/>
- Community Anthropic crates: `anthropic` 0.0.8, `anthropic-sdk-rust` 0.1.1
  (not recommended) — <https://crates.io/api/v1/crates?q=anthropic>

Protocols:

- MCP Streamable HTTP / stdio —
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
- MCP authorization (RFC 9728, 8414, 7591, 8707; OAuth 2.1) —
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- SSE event-stream interpretation (blank-line dispatch, multi-line data,
  comments, `id`, `retry`) — WHATWG HTML
  <https://html.spec.whatwg.org/multipage/server-sent-events.html>
