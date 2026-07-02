# Rayu — AI Coding Agent Suite

**Website:** https://rayu-web.vercel.app  
**Docs:** https://rayu-web.vercel.app/docs  
**Changelog:** https://rayu-web.vercel.app/changelog

Rayu is a terminal-based AI coding agent ecosystem. It consists of four independent
services that work together — or standalone with your own API keys.

---


## Quick Start (CLI)

```bash
npm install -g @rayu-dev/rayu-cli
rayu
```

Or run instantly without installing:

```bash
npx @rayu-dev/rayu-cli
```

On first launch, Rayu will guide you through connecting a provider (Anthropic, NVIDIA,
DeepSeek, OpenAI, Google Gemini, AWS Bedrock, or any OpenAI-compatible endpoint).

---

## Monorepo Services

| Directory | Language | Role |
|-----------|----------|------|
| [`rayu/`](./rayu/) | TypeScript + Bun + React/Ink | **The CLI** — the AI coding agent itself |
| [`rayu-backend/`](./rayu-backend/) | NestJS + Prisma + MySQL | **Accounts API** — users, auth, plans, billing |
| [`rayu-gateway/`](./rayu-gateway/) | Go + chi + Redis | **AI Gateway** — streaming proxy, rate limiting, credit tracking |
| [`rayu-web/`](./rayu-web/) | Next.js 15 + Clerk | **Website** — marketing site + user dashboard |
| [`deploy/`](./deploy/) | Docker Compose + Caddy | **Production stack** — single-VPS deployment |

---

## rayu/ — The CLI

The core AI coding agent. Bring your own API key and connect to any provider.

### Features

- **Multi-provider BYOK** — Anthropic, AWS Bedrock, OpenAI-compatible (NVIDIA, DeepSeek, Kimi, OpenRouter, Ollama, LM Studio), Google Vertex AI, or Rayu-hosted
- **Interactive TUI** — Full-screen terminal UI built on a custom React renderer with Flexbox layout, frame diffing, and zero-GC cell buffers
- **~70+ slash commands** — `/connect`, `/model`, `/help`, `/plan`, `/swarm`, `/mcp`, `/skill`, `/config`, and more
- **~45+ built-in tools** — Read, Write, Edit, Bash, Glob, Grep, WebFetch, Image/Video generation, MCP, LSP, task management, agent spawning, planning
- **MCP support** — Model Context Protocol for connecting external tools and data sources
- **Skill system** — Packaged, reusable procedures installable from GitHub or URL
- **Multi-agent swarms** — Orchestrate parallel agent teams with tmux/iTerm2/in-process backends
- **Voice mode** — Speech-to-text streaming input
- **Vim mode** — Vim-style keybindings for the prompt
- **Headless mode** — `--print` for automation, CI/CD, and scripting

### Quick commands

```bash
cd rayu
bun install          # install dependencies
bun run dev          # run from source
bun run build        # bundle → dist/rayu.js
bun test             # run tests
bun run typecheck    # TypeScript checking
```

---

## rayu-backend/ — Accounts API

NestJS backend handling user accounts, authentication, subscription plans, and billing.

### Key modules

- **Auth** — Clerk webhook → Rayu JWT (access + refresh tokens)
- **Users** — User profiles and preferences
- **Plans** — Subscription plan catalog (Free, Pro, Max)
- **Subscriptions** — Stripe-integrated subscription management
- **Payments** — Payment processing and invoicing
- **Usage** — Usage tracking and credit ledger
- **Credits** — Credit top-ups and consumption
- **Admin** — Admin panel for managing users and plans

### Quick commands

```bash
cd rayu-backend
npm install
npm run start:dev        # NestJS watch mode (port 4000, /api prefix)
npm run migrate:dev      # Prisma migrations
npm run test             # Jest unit tests
```

---

## rayu-gateway/ — AI Gateway

High-performance Go proxy that sits between the CLI and AI providers. Handles
authentication, rate limiting, credit tracking, and request routing.

### Routes

- `GET /healthz` — Health check
- `GET /v1/models` — Available models
- `POST /v1/chat/completions` — Streaming chat completions
- `GET /v1/credits` — Credit balance check
- `GET /v1/proxy` — Transparent BYO-key proxy

### Quick commands

```bash
cd rayu-gateway
go run ./cmd/gateway     # dev mode
go test ./...            # run all tests
go build ./cmd/gateway   # compile binary
```

---

## rayu-web/ — Website & Dashboard

Next.js 15 App Router site with marketing pages, user dashboard, billing, and docs.

### Pages

- Marketing landing, features, pricing
- User dashboard with usage stats
- Billing and subscription management
- CLI login with QR code
- Documentation hub
- Admin panel
- AI chatbot

### Quick commands

```bash
cd rayu-web
npm install
npm run dev          # Next.js dev server (port 3000)
npm run build        # Production build
npm run test         # Jest tests
```

---

## deploy/ — Production Stack

Single-VPS Docker Compose deployment with Caddy for TLS termination.

```bash
cd deploy
cp .env.example .env     # fill in secrets
docker compose up -d --build
```

**Caddy routing:**
- `/api/*` → backend (port 4000)
- `/gateway/*` → gateway (port 8080)
- `/*` → web (port 3000)

---

## Development

```bash
# Clone
git clone https://github.com/Choeng-Rayu/rayu-cli.git
cd rayu-cli

# Each service has its own dependencies — see the respective directories
```

---

## Project Links

- **Website:** https://rayu-web.vercel.app
- **Docs:** https://rayu-web.vercel.app/docs
- **Changelog:** https://rayu-web.vercel.app/changelog
- **Issues:** https://github.com/Choeng-Rayu/rayu-cli/issues
- **NPM:** https://www.npmjs.com/package/@rayu-dev/rayu-cli
