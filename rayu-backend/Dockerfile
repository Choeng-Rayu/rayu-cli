# ---- Builder: install all deps, generate Prisma client, compile TS ----
FROM node:20-alpine AS builder
WORKDIR /app

# Tolerate a flaky/slow build-host network: retry transient npm-registry fetch
# failures (ECONNRESET/ETIMEDOUT/socket hang up) with backoff instead of failing
# the whole image build on a single blip. Applies to every npm call in this stage.
ENV npm_config_fetch_retries=5 \
    npm_config_fetch_retry_factor=2 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000

COPY package.json package-lock.json* ./
# Retry npm install up to 3 times for flaky build-host networks (Coolify, etc.)
RUN for i in 1 2 3; do npm install && break || sleep 10; done
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
# build = `prisma generate && nest build`
RUN npm run build

# ---- Runner: production deps + generated Prisma client ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_factor=2 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000 \
    npm_config_fetch_timeout=600000

COPY package.json package-lock.json* ./
# Production deps include `prisma` (CLI) + `@prisma/client` so we can run
# `migrate deploy` and the generated client at runtime.
RUN for i in 1 2 3; do npm install --omit=dev && break || sleep 10; done && npm cache clean --force

COPY prisma ./prisma
# Generate the client against the production node_modules.
RUN npx prisma generate

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
# Applies migrations, then boots the API (plans are seeded on boot).
ENTRYPOINT ["./docker-entrypoint.sh"]
