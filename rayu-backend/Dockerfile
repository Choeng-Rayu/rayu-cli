# ---- Builder: install all deps, generate Prisma client, compile TS ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma
COPY src ./src
# build = `prisma generate && nest build`
RUN npm run build

# ---- Runner: production deps + generated Prisma client ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# Production deps include `prisma` (CLI) + `@prisma/client` so we can run
# `migrate deploy` and the generated client at runtime.
RUN npm install --omit=dev && npm cache clean --force

COPY prisma ./prisma
# Generate the client against the production node_modules.
RUN npx prisma generate

COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
# Applies migrations, then boots the API (plans are seeded on boot).
ENTRYPOINT ["./docker-entrypoint.sh"]
