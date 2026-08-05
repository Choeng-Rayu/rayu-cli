  kiro-cli --resume-id 05debe94-4530-4dbf-9c9d-6edadea5fa50

  
  Where the port stands
  
  Tasks 1–21 are complete and verified: 5 wire-format adapters, the full hosted billing path, and team billing. Last verified counts were 328 gateway unit tests, 55 core, 35 hosted_chat, 32 limiter, 21 metadata_routes, 18 store, plus the
  five adapter suites — all green with clippy -D warnings clean.
  
  Task 22 is partially done: crates/gateway/src/proxy.rs (helpers + I3 resolver, 14 unit tests green) and crates/gateway/src/routes/proxy.rs (the handler, wired at ANY /v1/proxy) are written and compile.
  crates/gateway/tests/proxy_route.rs has 18 tests, 14 passing, 4 failing.
  
  Task 22 — finish the BYO-key proxy
  
  Three of the four failures are test-harness issues; one is a real bug.
  
  The real bug — axum's default body limit pre-empts the gateway's own. Axum caps Bytes extraction at 2 MiB by default, so the handler's own 8 MiB MAX_REQUEST_BYTES check never runs and the 413 comes back without the X-Rayu-Proxy-Error
  header. This affects POST /anthropic/v1/messages too, where it is worse: an image-heavy Anthropic request between 2 and 8 MiB would be rejected that Go accepts. Fix by applying DefaultBodyLimit::max(MAX_REQUEST_BYTES) (or disable() plus
  the explicit checks already in place) to the router in routes/mod.rs, then add a hosted-path test proving a ~4 MiB body still reaches the handler.
  
  Test fixes:
  
  - a_proxied_request_relays_the_upstream_verbatim — wiremock's set_body_string overwrites the content-type with text/plain; use set_body_raw(bytes, "application/json").
  - the_daily_turn_cap_is_enforced... and retries_of_one_logical_request_burn_a_single_turn — reset_user_for_tests does not delete turnhold:<uid>:<logical> keys, which live until end of UTC day, so a second run of the suite sees a stale
  hold and never increments. Either give each run a unique logical id (nanos suffix) or extend the reset seam to clear holds.
  
  Still to add for Task 22: an integration test that a mid-stream upstream break is logged distinctly (the stream interrupted line), and a documented decision on the one deliberate deviation already in the code — Go refunds the turn on a
  mid-stream break, but the Rust arm cannot distinguish an upstream break from a client hang-up at that point, so it does not refund. Either accept and document it, or thread the sink-error signal through.
  
  Two Go tests are closed by the work already done: TestUsageEventSource and TestUsageEventSourceFitsColumn are ported as unit tests in proxy.rs.
  
  Task 23 — admin routes + provider diagnose
  
  Port from internal/server/: handleProviderHealth (admin-only, masked keys, usableKeys/routable, sorted by provider id), handleProviderTest + providertest.go (754 lines — one real 1-token upstream call through the production adapter,
  classification and suggestFix, with redactSecret over the output), providerdiagnose.go (214 lines), handleReload + reload.go (admin-gated immediate refresh that fans out over the config bus), and the two testLimiter sliding-window rate
  limiters (newTestLimiter, newSlidingLimiter(time.Minute, reloadPerAdmin)) — these exist so a dashboard button cannot be clicked in a loop against a real provider with a real key. Add improvement I4 here: the admin-only GET /v1/_stats
  reading shed_count(), breakers.states(), inflight.available(), ent.cached_users(), and the queue counters. Go tests to port: providertest_test.go, providerdiagnose_test.go, provideronboard_test.go, reload_test.go, reload_auth_test.go.
  
  Task 24 — finish main.rs boot and shutdown
  
  The dependency graph is already built in Go's order. Still owed: the periodic config-refresh ticker on cfg.config_refresh_interval(), the configbus subscriber wired to the reloader with a CancellationToken, provider-registry boot
  logging (Go's logProviderRegistry, including the "keys exist but cannot be opened" refusal), and draining both queues (wq and key_writes) on shutdown via Queue::shutdown(timeout) so a restart does not silently lose pending ledger and
  usage rows.
  
  Task 25 — parity harness
  
  A script that boots the Go gateway and the Rust gateway against the same MySQL and Redis, replays a fixture corpus (captured CLI request bodies) through both, and diffs status codes, response headers, JSON field order, and SSE byte
  streams. This is the artifact that justifies the cutover; the per-task tests prove units, this proves the whole.
  
  Task 26 — concurrency and long-request validation
  
  Measure what the port was for: sustained concurrent SSE streams against both binaries, comparing RSS, file descriptors, and time-to-first-token; verify a 10-minute generation is never truncated (the ResponseHeaderTimeout distinction
  from Task 12); verify RAYU_MAX_INFLIGHT sheds rather than queues under overload.
  
  Task 27 — Dockerfile, compose canary, CI
  
  Multi-stage Dockerfile (cargo chef or equivalent for layer caching, distroless or debian-slim runtime, non-root, the release profile already pinned in Cargo.toml). Add a new gateway-rust service to deploy/docker-compose.yml and
  docker-compose.coolify.yml alongside the existing gateway, sharing MySQL/Redis, with Caddy still pointing at Go. Image name rayu-gateway-rust, binary rayu-gateway. Add a .github/workflows/ci.yml job running cargo fmt --check, cargo
  clippy --all-targets -D warnings, and cargo test --all with MySQL and Redis service containers.
  
  Task 28 — README and cutover runbook
  
  Document the five intentional deviations (I1 Zeroizing/constant-time compare, I2 redaction + LOG_FORMAT=json, I3 SSRF DNS hardening with the RAYU_PROXY_PIN_DNS=0 kill switch, I4 admin stats, I5 short-secret boot warning), the documented
  design deviations (DashMap sharding instead of global locks, StreamStart replacing Go's (usage, wrote, err) triple, settlement in on_done, no isClientGone string matching), the three additive env vars, and the canary runbook: deploy
  alongside, shadow traffic, flip Caddy, monitor, roll back by flipping back.
  
  Standing invariants for whoever continues
  
  Re-run the 8-script Lua SHA1 comparison after touching limiter.rs — that check caught a silent drift in Task 21 where the Rust ORG_RESERVE_SCRIPT had lost Go's plancap lines, so no team charge was ever attributed to purchased credits.
  Trust the Go source over the older .rayu/plans/rayu-gateway-rust-port.md doc, which is materially out of date. Verify against the Go source rather than assuming: this session's assumptions were wrong four times (capability code names,
  topup currency casing, the extra label semantics, the org script's argument count), and each was caught only by reading Go.

