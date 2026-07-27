# Deploying Rayu on Coolify

Production runbook for the Rayu accounts stack: website, accounts API, AI gateway,
MySQL and Redis, deployed as one Docker Compose resource on Coolify.

Read [Provider key cutover](#5-provider-key-cutover-read-before-upgrading) before
upgrading an existing deployment — this release moves provider API keys out of the
environment and into encrypted database rows, and an existing deployment has a
short window where hosted models are unavailable.

---

## 1. What gets deployed

| Service   | Image / build       | Port | Public? | Notes |
|-----------|---------------------|------|---------|-------|
| `web`     | `rayu-web` (Next.js)| 3000 | yes     | Marketing site + user dashboard + admin |
| `backend` | `rayu-backend` (NestJS) | 4000 | yes | Accounts API under `/api`; applies DB migrations on boot |
| `gateway` | `rayu-gateway` (Go) | 8080 | yes     | Hosted AI proxy: routing, credits, provider keys |
| `mysql`   | `mysql:8.0`         | 3306 | **no**  | Single source of truth; persistent volume |
| `redis`   | `redis:7-alpine`    | 6379 | **no**  | Credit windows only — deliberately not persisted |

Compose file: `deploy/docker-compose.coolify.yml`. It has no edge proxy and no
published ports, because Coolify's own proxy fronts the stack; the single-VPS file
(`deploy/docker-compose.yml`, with Caddy on 80/443) is for a plain Docker host and
would fight Coolify for those ports.

Redis is not persisted on purpose: credit windows expire by TTL and the top-up
balance re-syncs from MySQL, so a Redis restart costs at most one in-flight
window, whereas a stale restored snapshot would mis-report balances.

---

## 2. DNS

Three records pointing at the Coolify server:

```
rayucode.com          A   <server ip>
api.rayucode.com      A   <server ip>
gateway.rayucode.com  A   <server ip>
```

Subdomains (rather than one domain with `/api` and `/gateway` paths) keep the
routing simple: Coolify assigns one domain per service, and every URL the clients
use is configurable, so nothing depends on path rewriting.

---

## 3. Environment variables

Coolify reads them from the compose file and shows them in the UI. Anything
written `${VAR:?}` is **required** — Coolify marks it red and refuses to deploy
until it is set, which is deliberate for values whose absence breaks the stack in
a way that is hard to diagnose later.

### Required

| Variable | What it is | How to generate |
|---|---|---|
| `MYSQL_ROOT_PASSWORD` | MySQL root password | `openssl rand -base64 32` |
| `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | App database credentials | `rayu` / `openssl rand -base64 32` / `rayu` |
| `RAYU_JWT_SECRET` | Signs CLI + dashboard sessions. **Backend and gateway must share it** | `openssl rand -hex 32` |
| `RAYU_PROVIDER_SECRET` | Master key that encrypts provider API keys. **Backend and gateway must share it** | `openssl rand -base64 48` (min 32 chars) |
| `NEXTAUTH_SECRET` | NextAuth session encryption | `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth app | Google Cloud console |
| `PUBLIC_SITE_URL` | `https://rayucode.com` | — |
| `PUBLIC_API_URL` | `https://api.rayucode.com/api` (note the `/api` prefix) | — |
| `PUBLIC_GATEWAY_URL` | `https://gateway.rayucode.com` | — |

Google OAuth redirect URI: `https://rayucode.com/api/auth/callback/google`.

### Optional

| Variable | Default | Effect |
|---|---|---|
| `SEED_CATALOG` | unset | `true` populates the shipped example providers/models on a brand-new database. Leave unset in production: the catalog is admin-owned and a restart must never re-create rows an operator deleted |
| `CONFIG_REFRESH_SECONDS` | `30` | How long a provider/model/key edit takes to reach the gateway |
| `RAYU_MAX_INFLIGHT` | unlimited | Global cap on concurrent hosted streams |
| `RAYU_SHARED_BOT_TOKEN` | unset | Shared Telegram bot |
| `BAKONG_*` | unset | KHQR payments |

### The two secrets that must match

`RAYU_JWT_SECRET` and `RAYU_PROVIDER_SECRET` are each used by **two** services.
They are the only cross-service secrets, and each fails in its own way:

- `RAYU_JWT_SECRET` mismatch → every hosted request is `401`, logins look fine.
- `RAYU_PROVIDER_SECRET` mismatch → the gateway **refuses to start** when provider
  keys exist, logging the variable name. That is intentional: a gateway that boots
  and then 500s every hosted request is far harder to diagnose than one that does
  not boot.

**Losing `RAYU_PROVIDER_SECRET` is unrecoverable** — stored keys cannot be
decrypted and must be re-entered. Keep it in a password manager, not only in
Coolify.

---

## 4. First deploy (new deployment)

1. **Coolify → Project → + New Resource → Docker Compose**, source = this Git repo.
   - Base Directory: `/deploy`
   - Compose file: `docker-compose.coolify.yml`
2. Set the environment variables above.
3. **Assign domains.** Coolify needs the container port when it is not 80:
   - `web` → `https://rayucode.com:3000`
   - `backend` → `https://api.rayucode.com:4000`
   - `gateway` → `https://gateway.rayucode.com:8080`
   - `mysql` and `redis`: no domain, no ports — they stay private to the stack.
4. **Deploy.** The backend entrypoint runs `prisma migrate deploy` before booting,
   so the schema is created (or upgraded) automatically. Watch its logs for
   `prisma migrate deploy` followed by `starting API`.
5. **Verify** (section 6), then **build the catalog** (section 7).

---

## 5. Provider key cutover (read before upgrading)

This release changes where provider API keys live:

| | Before | After |
|---|---|---|
| Storage | gateway environment variable, named by `providers.keyEnv` | `provider_api_keys` rows, AES-256-GCM encrypted |
| Adding a provider | edit env + redeploy | dashboard only, no redeploy |
| Multiple keys | comma-separated env value | separate rows with priority, cooldown and health |

Migrations `0000000000013_drop_key_env` and `0000000000014_topup_rate` are
**destructive**: they drop `providers.keyEnv` and
`app_settings.topupCentsPer1kCredits` (its value is preserved as
`creditsPerDollar`, computed exactly). They run automatically on backend boot, so
plan the upgrade as a short maintenance window.

**Consequence:** the moment migrations finish, no provider has a key. Hosted
requests answer `500 provider key not configured` until keys exist.

### Option A — scripted (recommended, window ≈ seconds)

Right after the deploy, run the backfill from the backend container with the same
key values the gateway used to have:

```bash
# Coolify → backend service → Terminal
PROVIDER_KEYS_INLINE="deepseek=sk-...,longcat=sk-...,rayu-ollama=k1,k2" \
  npm run keys:backfill
```

It goes through the same service the dashboard uses (validated, encrypted,
audit-logged with the mask only), turns a comma-separated value into several keys
with ascending priority exactly as the old rotation did, and is safe to re-run —
an already-stored key is reported as `skipped`, never duplicated or overwritten.

### Option B — by hand

Dashboard → **Providers** → for each provider → *Add key & test*. Each key is
tested against the real upstream immediately (see section 7).

### Rollback

Rolling back the code is safe; rolling back the **schema** is not, because the
dropped columns are gone. If you must revert:

1. Restore the MySQL backup taken before the upgrade (section 9), then
2. redeploy the previous image tag.

Take that backup. It is the only way back.

---

## 6. Post-deploy verification

```bash
# 1. Health
curl -sf https://api.rayucode.com/api/health          && echo backend ok
curl -sf https://gateway.rayucode.com/healthz         && echo gateway ok
curl -sfI https://rayucode.com | head -1                             # web 200

# 2. Gateway boot log — the line that tells you whether routing works at all
#    providers: N in registry: <name>[<format>]→<endpoint> keys=<usable>/<total> (ok)
#    Anything other than (ok) is explained on its own line underneath.

# 3. Provider health (admin session token)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://gateway.rayucode.com/v1/_provider-health | jq '.providers[] |
    {name, routable, keyCount, usableKeys, configError}'
```

Then, signed in as an admin in the dashboard:

- **Providers** — every provider shows `routable`, and each key shows `active`.
- Press **Test** on a model. It performs a real 1-token request through the
  production adapter and key rotation, charges nothing, and reports which stage
  passed (`endpoint reachable` / `key accepted` / `model id accepted`).
- **Plans & Credits** — each paid plan grants the models it should; the credit
  top-up rate reads as intended.

Finally, from a CLI signed in to production:

```bash
RAYU_API_URL=https://api.rayucode.com/api \
RAYU_GATEWAY_URL=https://gateway.rayucode.com rayu
# /model    → the hosted catalog, ids + names + context windows from the backend
# a prompt  → streams
# /context  → renders (token counting is free and server-side)
```

---

## 7. Building the catalog (admin, no redeploy)

Everything below is data, changed in the dashboard and picked up by the gateway
within `CONFIG_REFRESH_SECONDS`:

1. **Providers → Add a provider** (3 steps: connection → key → first model). The
   provider is saved **disabled**, the model is tested through the real adapter,
   and both are enabled only if the test passes. A failure keeps your work and
   tells you which field is wrong.
2. Add more keys per provider for rotation. A `429` puts one key on cooldown; a
   `401/403` takes it out of rotation until replaced. State survives restarts.
3. **Plans & Credits → model access** — a model is invisible to users until a plan
   grants it.
4. Set the four credit charges per model (input / output / cache-read /
   cache-write). They are used **verbatim**; nothing is derived from cost prices.

Provider formats and their exact requirements are documented in
[`docs/hosted-provider-contract.md`](../docs/hosted-provider-contract.md),
including AWS Bedrock (per-model invoke URL, inference-profile ids).

---

## 8. Client (CLI) configuration

The published CLI has its endpoints baked at build time:

```bash
cd rayu
RAYU_BUILD_OAUTH=true \
RAYU_BUILD_API_URL=https://api.rayucode.com/api \
RAYU_BUILD_WEB_URL=https://rayucode.com \
RAYU_BUILD_GATEWAY_URL=https://gateway.rayucode.com \
  bun run build
```

Runtime `RAYU_API_URL` / `RAYU_WEB_URL` / `RAYU_GATEWAY_URL` still override the
baked values, which is how you point a local CLI at staging.

Nothing about the hosted catalog is baked in: model ids, names and context windows
all arrive from `GET /me/entitlements`, so adding or renaming a model needs no CLI
release.

---

## 9. Backups

MySQL is the only stateful service that matters.

```bash
# Backup (Coolify → mysql service → Terminal, or via docker exec)
mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction \
  --routines --triggers "$MYSQL_DATABASE" | gzip > /tmp/rayu-$(date +%F).sql.gz

# Restore
gunzip -c rayu-YYYY-MM-DD.sql.gz | mysql -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"
```

A dump contains **encrypted** provider keys. It is useless without
`RAYU_PROVIDER_SECRET` — which is the point — so back up that secret separately,
and never in the same place as the dump.

Coolify's scheduled backups (S3 destination) cover this; set a retention that
matches how far back you would want to roll a schema change.

---

## 10. Operating

**Rotating a provider key** — Providers → the key → *Replace* → paste → it is
tested immediately. The old key is overwritten in place and any previous "invalid"
verdict is cleared, so a replaced key returns to rotation without a restart.

**Rotating `RAYU_PROVIDER_SECRET`** — there is no re-encrypt path. Set the new
value, redeploy, then re-enter every provider key. Do it in a window.

**Rotating `RAYU_JWT_SECRET`** — invalidates every session: all CLI users must
`/login` again. Set it in both services at once.

**A provider stops working** — Providers page first: the health badge and per-key
status come from the gateway itself. Then press *Test*: it names the failing stage
and the exact URL it called, which is usually enough. Gateway logs use one line
per rejection with a `reason=` field.

**Scaling** — the gateway is stateless (all state is MySQL + Redis), so it scales
horizontally; per-key cooldowns are per-process but the durable status is shared
through MySQL. Cap concurrency with `RAYU_MAX_INFLIGHT` before adding replicas.

---

## 11. Security notes

- Provider keys are never returned by any API after being stored — responses carry
  a mask only, and the same is true of logs and the provider-test endpoint.
- `mysql` and `redis` have no domain and no published ports; they are reachable
  only from inside the stack network.
- Provider base URLs are validated (https, no private/metadata hosts) by the
  backend on write **and** by the gateway at route time, so a row written directly
  to the database cannot turn the gateway into an SSRF pivot.
- Every `/v1` gateway route requires a valid Rayu JWT; admin-only routes
  additionally require an admin/superadmin role.
- `GATEWAY_CORS_ORIGINS` is set to the site origin. It defaults to `*`, which is
  safe only because auth is still required — pin it anyway.
