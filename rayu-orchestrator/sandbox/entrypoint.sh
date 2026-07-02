#!/usr/bin/env bash
#
# Sandbox Entry_Script (Req 4.4, 6.1-6.7).
#
# Runs as UID 10001 inside the hardened, egress-restricted Sandbox. It drives the
# rayu-cli collaborator swarm headlessly over stream-json and forwards the swarm's
# NDJSON stdout to the orchestrator line-by-line (the orchestrator captures this
# container's stdout via the Docker logs API), while tee-ing a durable per-build
# trace into the workspace for replay/debugging.
#
# BYOK handling (Req 6.5): the End_User's model key reaches rayu-cli ONLY through
# the provider environment variables the SandboxRunner injects (e.g.
# RAYU_OPENAI_API_KEY). This script never writes any environment value to a file
# and never enables shell tracing (`set -x`), which would echo the key.

# NOT `set -e`: we must capture rayu-cli's exit status from the pipeline and
# forward it deliberately. `set -u` catches missing required env; pipefail makes
# the pipeline's failure observable.
set -uo pipefail

WORKSPACE="${WORKSPACE_DIR:-/workspace}"
TRACE_FILE="${WORKSPACE}/.rayu-stream.ndjson"

# Required inputs (provided as env by the SandboxRunner). BYOK provider vars are
# consumed by rayu-cli directly and are intentionally not referenced here.
: "${RAYU_PROMPT:?RAYU_PROMPT is required}"
: "${BUILD_MODEL:?BUILD_MODEL is required}"

# Compose the two stream-json USER messages fed to rayu-cli on stdin, in the
# SDKUserMessage shape rayu-cli expects:
#   1) "/collaborator_swarm"              — engage the Tier-2 collaborator swarm (Req 6.1)
#   2) "<prompt>\n\n<Build_Addendum>"     — the build request + artifact contract (Req 6.4)
# JSON is encoded with node (always present in this base image) so arbitrary
# prompt/addendum text is escaped correctly — never via shell string building.
emit_messages() {
  node -e '
    const enc = (text) => JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: ""
    });
    const prompt = process.env.RAYU_PROMPT || "";
    const addendum = process.env.BUILD_ADDENDUM || "";
    const second = addendum ? prompt + "\n\n" + addendum : prompt;
    process.stdout.write(enc("/collaborator_swarm") + "\n");
    process.stdout.write(enc(second) + "\n");
  '
}

# Invoke the swarm headlessly (Req 6.2). --print is included; per Req 6.3 the run
# is still valid even if only --print were absent (it affects formatting only).
# stdout is line-buffered (stdbuf -oL) so each NDJSON line is forwarded as soon as
# it is produced (Req 6.6, "no buffering beyond a line"), tee'd to a durable trace
# while the original stdout remains the live channel the orchestrator reads.
emit_messages \
  | rayu --print \
         --agent-teams \
         --input-format stream-json \
         --output-format stream-json \
         --verbose \
         --dangerously-skip-permissions \
         --model "${BUILD_MODEL}" \
  | stdbuf -oL tee "${TRACE_FILE}"

# Forward rayu-cli's exit status (stage index 1 of `emit | rayu | tee`), not
# tee's, so SandboxRunner.Wait observes the swarm's true outcome. The primary
# completion signal is still the stream-json `result` message (Req 6.7); a
# non-zero exit is the fallback error signal (Req 5.8 / 7.3).
exit "${PIPESTATUS[1]}"
