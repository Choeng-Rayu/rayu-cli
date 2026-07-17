# ---- Builder ----
FROM node:20-alpine AS builder
WORKDIR /app

# Set NODE_ENV=development during install to include devDependencies needed for build
ENV NODE_ENV=development

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here.
ARG NEXTAUTH_SECRET
ARG NEXTAUTH_URL
ARG GOOGLE_CLIENT_ID
ARG GOOGLE_CLIENT_SECRET
ARG NEXT_PUBLIC_RAYU_API_URL
ARG NEXT_PUBLIC_RAYU_GATEWAY_URL
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
ENV GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
ENV NEXT_PUBLIC_RAYU_API_URL=$NEXT_PUBLIC_RAYU_API_URL
ENV NEXT_PUBLIC_RAYU_GATEWAY_URL=$NEXT_PUBLIC_RAYU_GATEWAY_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Runner ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# next.config.mjs uses output:'standalone' which emits a minimal server.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
