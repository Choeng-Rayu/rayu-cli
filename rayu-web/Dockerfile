# ---- Builder ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install with NODE_ENV=development so npm includes devDependencies
# (typescript, @types/*, etc.) needed for the build step.
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
ARG NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
ENV GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
ENV NEXT_PUBLIC_RAYU_API_URL=$NEXT_PUBLIC_RAYU_API_URL
ENV NEXT_PUBLIC_RAYU_GATEWAY_URL=$NEXT_PUBLIC_RAYU_GATEWAY_URL
ENV NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=$NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
ENV NEXT_TELEMETRY_DISABLED=1
# Switch to production for the build — Next.js requires NODE_ENV=production
# for correct static page prerendering. Building with NODE_ENV=development
# causes "<Html> should not be imported outside of pages/_document" errors
# on the auto-generated /404 and /_error pages.
ENV NODE_ENV=production
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
