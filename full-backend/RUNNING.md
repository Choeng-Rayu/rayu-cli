# Running the Rayu Gateway locally (with live Docker logs)

Run the gateway as a Docker container so you can stream its logs with
`docker logs -f`. This connects to your **already‑running MySQL** (`deploy-mysql-1`,
the `rayu` DB) — it does **not** touch your data.

## Prerequisites
- Docker installed and the MySQL container `deploy-mysql-1` running
  (`docker ps | grep mysql`).
- Your **DeepSeek API key** (rotate the one shared in chat first).
- `RAYU_JWT_SECRET` — the same value as in `rayu-backend/.env` (the gateway must
  share it to verify Rayu login tokens).

---

## 1. Start Redis (credit windows)
```bash
docker run -d --name rayu-redis -p 6379:6379 redis:7-alpine
```

## 2. Build the gateway image
```bash
cd ~/rayu-cli/rayu-gateway
docker build -t rayu-gateway:local .
```

## 3. Start the gateway container
`--network host` lets the container reach MySQL on `127.0.0.1:3306` and Redis on
`6379`. Export your key first.
```bash
export DEEPSEEK_API_KEY='sk-...your-rotated-key...'
SECRET=$(grep -E '^RAYU_JWT_SECRET=' ~/rayu-cli/rayu-backend/.env | cut -d= -f2-)

docker run -d --name rayu-gateway --network host \
  -e PORT=8080 \
  -e RAYU_JWT_SECRET="$SECRET" \
  -e DATABASE_URL='mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu' \
  -e REDIS_URL='redis://localhost:6379' \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  rayu-gateway:local
```

## 4. Confirm it's up
```bash
curl localhost:8080/healthz        # -> {"status":"ok"}
```

---

## 5. ✅ Watch live logs (what you asked for)
```bash
docker logs -f rayu-gateway              # follow live (Ctrl-C stops following; container keeps running)
docker logs -f --tail=100 rayu-gateway   # last 100 lines, then follow
docker logs --since=5m rayu-gateway      # only the last 5 minutes
docker logs --timestamps rayu-gateway    # with timestamps
```
The gateway logs a line on boot (`rayu-gateway listening on :8080`) and prints
errors (bad token, upstream failures, etc.). Keep this open in one terminal
while you send requests from another.

---

## 6. Get a token for a paid account
Easiest — copy the token from a logged‑in CLI session:
```bash
node -e "process.stdout.write(require(require('os').homedir()+'/.rayu/rayu-auth.json').accessToken)"
```
Or mint one for the pro account (`choengrayu233@gmail.com`):
```bash
cd ~/rayu-cli/rayu-backend && set -a; . .env; set +a
TOK=$(MINT_CLERK_ID=user_3F9dLC81k2cBWrQMVGNNg0h2qd9 MINT_EMAIL=choengrayu233@gmail.com \
  npx ts-node scripts/mint-session.ts 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).accessToken))")
```

## 7. Test real‑time streaming
`curl -N` disables buffering so chunks appear as they arrive:
```bash
curl -N -X POST http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Write a haiku about streaming."}],"stream":true,"max_tokens":400}'
```
Check live credit usage anytime:
```bash
curl -s localhost:8080/v1/credits -H "Authorization: Bearer $TOK"
```
> Note: `deepseek-v4-flash` (and `-pro`) are **reasoning** models — they stream
> their thinking in `reasoning_content` first, then the answer in `content`.
> Use `max_tokens` ≥ 200 or you'll only see the reasoning part.

## 8. Stop when done
```bash
docker rm -f rayu-gateway rayu-redis     # MySQL keeps running
```

---

## Restart next time (after step 2 once)
```bash
docker start rayu-redis
docker run -d --name rayu-gateway --network host \
  -e PORT=8080 -e RAYU_JWT_SECRET="$SECRET" \
  -e DATABASE_URL='mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu' \
  -e REDIS_URL='redis://localhost:6379' \
  -e DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" rayu-gateway:local
docker logs -f rayu-gateway
```
(If the gateway container still exists from before: `docker start -a rayu-gateway`
runs it and attaches to its logs in one step.)

---

## Development: run natively with `go run` (reads `.env`) — recommended for dev
The gateway loads a local `.env` on startup (via `godotenv`), so you don't pass
env vars inline. MySQL + Redis stay in Docker; the gateway runs on your machine
(fastest loop, logs straight in your terminal). Use the package path
`./cmd/gateway`, **not** `main.go`.

**1) One‑time — create `.env` in `rayu-gateway/`** (it's gitignored, never committed):
```bash
cd ~/rayu-cli/rayu-gateway
cp .env.example .env
```
Edit `.env` for local dev:
```dotenv
PORT=8080
RAYU_JWT_SECRET=<same value as rayu-backend/.env>
DATABASE_URL=mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu
REDIS_URL=redis://localhost:6379
DEEPSEEK_API_KEY=sk-...your-rotated-key...
```

**2) Make sure MySQL + Redis are running (Docker):**
```bash
docker start deploy-mysql-1                                  # your existing DB
docker run -d --name rayu-redis -p 6379:6379 redis:7-alpine  # once; later: docker start rayu-redis
```

**3) Run the gateway (reads `.env`, logs in your terminal):**
```bash
cd ~/rayu-cli/rayu-gateway
go run ./cmd/gateway
```
Edit code → Ctrl‑C → re‑run. That's the dev loop. (Inline env vars, if you set
any, still override `.env`.)

> **Dev vs prod config:** the same code works in both. In dev, `go run` reads
> `.env`. In production, `.env` is gitignored **and** excluded from the Docker
> image (`.dockerignore`), and `godotenv` never overrides variables already set —
> so Compose‑injected env always wins and the missing `.env` is simply ignored.

## Alternative: Docker Compose (full stack: mysql + backend + web + redis + gateway)
```bash
cd ~/rayu-cli/deploy
cp .env.example .env          # fill MYSQL_*, RAYU_JWT_SECRET, DEEPSEEK_API_KEY
docker compose up -d --build redis gateway
docker compose logs -f gateway          # <-- live logs via compose
docker compose down                     # stop the stack
```
With compose the gateway is reachable on the same machine at the service port
and, in production, behind Caddy at `https://<your-site>/gateway`.

---

## Use it from the CLI (no API key, no /connect)
Run the backend too (`cd ~/rayu-cli/rayu-backend && node dist/main.js`), then:
```bash
USE_RAYU_OAUTH=true \
RAYU_API_URL=http://localhost:4000/api \
RAYU_GATEWAY_URL=http://localhost:8080 \
rayu
```
Inside: `/login` → the `rayu-hosted` provider auto‑activates for a paid plan →
`/model` → pick `deepseek-v4-flash` → chat. `/credits` shows live usage.

## Troubleshooting
- **401 from the gateway** → `RAYU_JWT_SECRET` doesn't match the backend's, or the
  token expired (mint a new one).
- **403 "model not available on your plan"** → that account isn't on a plan with
  hosted models (basic = bring‑your‑own‑key; hosted models start at `pro`).
- **500 "provider key not configured"** → `DEEPSEEK_API_KEY` wasn't passed to the
  container; check `docker logs rayu-gateway`.
- **Can't reach MySQL** → ensure `deploy-mysql-1` is up and the container was run
  with `--network host`.
