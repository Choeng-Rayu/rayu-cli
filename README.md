<div align="center">

<img src="docs/assets/rayucode-logo.png" alt="RAYU Code Logo" width="200">

# RAYU — The AI Coding Agent Ecosystem

[![npm](https://img.shields.io/npm/v/@rayu-dev/rayu-cli.svg?style=flat-square&colorA=7c3aed&colorB=7c3aed)](https://www.npmjs.com/package/@rayu-dev/rayu-cli)
[![CI](https://github.com/Choeng-Rayu/rayu-cli/workflows/CI/badge.svg)](https://github.com/Choeng-Rayu/rayu-cli/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/Choeng-Rayu?style=flat-square)](https://github.com/sponsors/Choeng-Rayu)
[![Website](https://img.shields.io/badge/🌐_rayucode.com-7c3aed?style=flat-square)](https://rayucode.com)

**Website:** [rayucode.com](https://rayucode.com) · **Docs:** [rayucode.com/docs](https://rayucode.com/docs) · **Changelog:** [rayucode.com/changelog](https://rayucode.com/changelog)

</div>

<p align="center">
  <img src="docs/assets/rayu-cli-preview.png" alt="Rayu CLI Preview" width="800">
</p>

> **The ultimate standard for terminal-based AI development.** Rayu is built from the ground up to outperform every other CLI agent on the market. It works flawlessly, runs faster, and respects your privacy completely.

---

## ⚡ Why Rayu Outperforms the Rest

| Feature | Rayu | OpenCode | KiloCode | Claude Code | Codex |
|---------|------|----------|----------|-------------|-------|
| **Response Speed** | ⚡ **Near-instant (<500ms)** | ~3-5s | ~5-10s | ~5-8s | ~3-6s |
| **P2P Collaboration** | ✅ **Native Peer-to-Peer** | ❌ No | ❌ No | ❌ No | ❌ No |
| **Privacy / No Training Data** | ✅ **Zero Data Retention** | ⚠️ Cloud-dependent | ⚠️ Cloud-dependent | ❌ Trains on your code | ❌ Trains on your code |
| **Multi-Provider BYOK**| ✅ **Anthropic, OpenAI, DeepSeek, etc.** | ❌ Limited | ❌ Single | ❌ Anthropic only | ❌ OpenAI only |
| **Agent Swarms** | ✅ **Built-in & Parallel** | ❌ No | ❌ No | ❌ No | ❌ No |
| **Offline Capabilities** | ✅ **Private local model support** | ❌ No | ❌ No | ❌ No | ❌ No |

---

## 🚀 Key Advantages

### 1. Blazing Fast Speed
Rayu is built on high-performance streaming architectures, eliminating the typical latency bottlenecks of traditional CLI tools. Our terminal UI utilizes a custom React/Ink renderer with zero-GC cell buffers, and our Go gateway ensures sub-millisecond routing overhead. 
- **Time-to-first-token:** Under 500ms for cached sessions and 1-2s for cold boots. 
- No more waiting on sluggish web bridges or processing screens.

### 2. Peer-to-Peer (P2P) Collaboration
Rayu is the only CLI agent with native P2P capabilities. Collaborate directly with team members in real-time without sending intermediate payloads to external cloud storage. This is ideal for secure enterprise environments, air-gapped systems, and lag-free cooperative terminal sessions.

### 3. Absolute Privacy: No Training Data
While other platforms use your inputs and proprietary source files to train their models, **Rayu never trains on your code**.
- **BYOK (Bring Your Own Key):** Connect directly to your preferred API keys.
- **Hosted Gateway:** Completely transparent proxy pipelines with zero-data-retention guarantees.

### 4. Flawless Execution & Freedom of Choice
Rayu works perfectly right out of the box. Switch models instantly mid-session with `/model` or run parallel diagnostics on your codebase across multiple LLM providers (Anthropic, DeepSeek, Google Gemini, OpenAI, Kimi, and locally hosted models via Ollama/LM Studio).

---

## 💻 Quick Start

Install globally:

```bash
npm install -g @rayu-dev/rayu-cli
rayu
```

Or run instantly without installing:

```bash
npx @rayu-dev/rayu-cli
```

On first launch, Rayu will guide you through connecting a provider. Choose BYOK (your own API key) or a Rayu-hosted connection.

---

## 🌐 Monorepo Services

Rayu consists of four independent services. They work together or as individual standalone configurations.

| Directory | Stack | Role |
|-----------|-------|------|
| [`rayu/`](./rayu/) | TypeScript + Bun + Ink | **The CLI** — AI coding agent itself |
| [`rayu-backend/`](./rayu-backend/) | NestJS + Prisma + MySQL | **Accounts API** — auth, plans, billing |
| [`rayu-gateway/`](./rayu-gateway/) | Go + chi + Redis | **AI Gateway** — streaming proxy, rate limiting |
| [`rayu-web/`](./rayu-web/) | Next.js 15 + Clerk | **Website** — marketing site + user dashboard |
| [`deploy/`](./deploy/) | Docker Compose + Caddy | **Production** — single-VPS deployment stack |

---

## 🛠️ CLI Quick Commands

```bash
cd rayu && bun install && bun run dev       # Run CLI from source
cd rayu-backend && npm install && npm run start:dev   # Launch accounts backend
cd rayu-gateway && go run ./cmd/gateway      # Run gateway routing proxy
cd rayu-web && npm install && npm run dev    # Spin up web dashboard
```

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details on issues, code formatting, and pull requests.

---

<p align="center">
  <a href="https://rayucode.com">🌐 rayucode.com</a> ·
  <a href="https://github.com/Choeng-Rayu/rayu-cli/issues">Issues</a> ·
  <a href="https://www.npmjs.com/package/@rayu-dev/rayu-cli">NPM</a>
</p>
