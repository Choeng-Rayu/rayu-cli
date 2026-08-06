# Sandbox_Image (Req 4) — the hardened, single-purpose image in which the
# rayu-cli collaborator swarm runs headlessly to generate one project. It is
# built and pinned at image-build time and never mutated at runtime; the
# SandboxRunner (internal/sandbox) layers the run-time hardening (read-only
# rootfs, dropped caps, egress-only network, resource limits) on top.
#
# Build:  docker build --build-arg RAYU_CLI_VERSION=<x.y.z> -t <SANDBOX_IMAGE> .
FROM node:22-bookworm-slim

# Exact rayu-cli pin (Req 4.2). Intentionally no default so the build fails fast
# unless an explicit version is supplied as a --build-arg.
ARG RAYU_CLI_VERSION

# Minimal tools the swarm needs to scaffold and self-verify a project: git and a
# current CA bundle for HTTPS to the model/registry endpoints. Kept lean with
# --no-install-recommends; node/npm come from the base image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fail the build when the pin is missing (Req 4.2)...
RUN test -n "${RAYU_CLI_VERSION}" \
 || { echo "RAYU_CLI_VERSION build-arg is required" >&2; exit 1; }

# ...and when the pinned rayu-cli is not installable (Req 4.5). Installed as root
# into the global prefix so the non-root sandbox user can execute it read-only.
RUN npm install -g "@rayu-dev/rayu-cli@${RAYU_CLI_VERSION}" \
 || { echo "pinned rayu-cli ${RAYU_CLI_VERSION} not installable" >&2; exit 1; }

# Non-root sandbox user (Req 4.3). UID 10001 is also asserted by the run policy
# (container.Config.User) and is one of the CLI's skip-permissions preconditions.
RUN useradd -u 10001 -m sandbox

# Entry_Script as the image entrypoint (Req 4.4).
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entry

USER 10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entry"]
