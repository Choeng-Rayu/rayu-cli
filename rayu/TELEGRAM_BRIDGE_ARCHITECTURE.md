# RAYU CLI — Telegram Bridge Architecture

> **Purpose:** A complete reference for how the Telegram bridge connects a Telegram chat to the RAYU CLI, so you can model a web-app connection flow on the same patterns.

---

## 1. What the Telegram Bridge Does

The Telegram bridge turns a Telegram chat into a **remote control** for the RAYU CLI. Once linked, a user can:

- Send prompts from their phone → the CLI runs them in the terminal
- Stream AI responses back to Telegram in real time
- Approve/deny tool executions (file writes, bash commands) from Telegram
- Switch between multiple open CLI sessions
- Run slash commands (`/model`, `/connect`, `/status`) from Telegram
- (Optionally) uninstall the CLI remotely — gated by a separate safety switch

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RAYU CLI (this machine)                      │
│                                                                     │
│  ┌──────────────┐     ┌──────────────────┐     ┌────────────────┐  │
│  │  Telegram     │     │  Bridge Leader   │     │  CLI Session   │  │
│  │  Bot API      │◄───►│  (one per host)  │◄───►│  (REPL queue)  │  │
│  │  (polling)    │     │                  │     │                │  │
│  └──────┬───────┘     └────────┬─────────┘     └────────────────┘  │
│         │                      │                                    │
│         │              ┌───────┴────────┐                           │
│         │              │  telegram-     │                           │
│         │              │  bridge.lock   │  ← single-session lock   │
│         │              └────────────────┘                           │
│         │                                                          │
│  ┌──────┴──────────────────────────────────────────────────────┐   │
│  │  Config files (~/.rayu/)                                     │   │
│  │  ├── telegram.json          (mode, token, link, auto-attach) │   │
│  │  ├── telegram-attached.json (which session receives prompts) │   │
│  │  └── telegram-bridge.lock   (PID heartbeat lock)             │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │
         │  Long-poll (getUpdates) or backend relay
         ▼
┌─────────────────┐     ┌──────────────────────┐
│  Telegram API   │     │  rayu-backend         │
│  (BYO mode)     │     │  (hosted mode)        │
│                 │     │  /telegram/pair       │
│                 │     │  /telegram/link       │
│                 │     │  /telegram/updates    │
│                 │     │  /telegram/relay      │
└─────────────────┘     └──────────────────────┘
```

---

## 3. Two Connection Modes

| | **Hosted (shared bot)** | **BYO (your own bot)** |
|---|---|---|
| **Bot identity** | Rayu runs the bot (`RAYU_SHARED_BOT_TOKEN` on backend) | You create one via @BotFather |
| **Pairing** | Backend issues a pairing code; CLI polls backend | CLI generates a 96-bit token; you send `/start <token>` to your bot |
| **Transport** | All Telegram API calls relayed through `rayu-backend` | Direct to `api.telegram.org` |
| **Privacy** | Messages pass through Rayu's server | Peer-to-peer, no middleman |
| **Setup** | None — just scan QR | Paste bot token into `/telegram-bot` |
| **Default** | ✅ Yes | Opt-in (press `b` during connect) |

### Hosted Mode Flow

```
CLI                          rayu-backend                    Telegram
 │                               │                              │
 │── POST /telegram/pair ───────►│                              │
 │◄── { code, deepLink } ────────│                              │
 │                               │                              │
 │  Show QR / deep link          │                              │
 │                               │◄── User scans, /start code ──│
 │                               │                              │
 │── GET /telegram/link ────────►│                              │
 │◄── { linked: true, chatId } ──│                              │
 │                               │                              │
 │  Activate bridge ─────────────┼──────────────────────────────┤
 │                               │                              │
 │── GET /telegram/updates ─────►│◄── Telegram delivers msg ────│
 │◄── { updates: [...] } ────────│                              │
```

### BYO Mode Flow

```
CLI                              Telegram                       @BotFather
 │                                  │                              │
 │  User pastes bot token           │                              │
 │  (or uses existing token)        │                              │
 │                                  │                              │
 │  Generate 96-bit pair token      │                              │
 │  Show QR: t.me/<bot>?start=xxx   │                              │
 │                                  │                              │
 │                                  │◄── User sends /start xxx ────│
 │◄── getUpdates: /start xxx ───────│                              │
 │                                  │                              │
 │  consumePendingToken(xxx)        │                              │
 │  Bind chatId                     │                              │
 │── sendMessage("✅ Linked") ─────►│                              │
 │                                  │                              │
 │  Activate bridge ────────────────┼──────────────────────────────┤
```

---

## 4. Pairing & Linking (Security)

### The Pending Token

The pending token is the **only gate** between a stranger's chat and control of the CLI.

```typescript
// BYO mode: 96-bit random, base64url, 10-min TTL
const pairToken = randomBytes(12).toString('base64url')

// Hosted mode: backend-generated code, 10-min TTL
const pairing = await createHostedPairing()
```

**Token discipline:**
- **Single use** — consumed on first valid `/start`, then destroyed
- **Time-bound** — 10 minutes (BYO), backend-enforced (hosted)
- **Attempt-bounded** — 5 wrong guesses (BYO) burns the token; user must start over
- **Constant-time comparison** — no timing side-channel
- **Private-chat only** — pairing from a group/supergroup is refused before the token is checked (so a group can't burn a token)
- **Not persisted** — in-memory only (BYO); a CLI restart invalidates it

### Chat Binding

Once paired, the `linkedChatId` is written to `telegram.json`. Only this chat can drive the CLI. All other chats are ignored (except `/link` and `/start` for re-pairing).

### Bot Identity Tracking

`linkedBotUsername` records **which bot** the link belongs to. On reconnect, the CLI checks if the stored bot matches the current one — if the deployment switched bots, the stale link is detected and the user is prompted to re-pair.

---

## 5. The Bridge Loop

The bridge is a **long-polling loop** that runs in the process holding the `telegram-bridge.lock`.

```typescript
// Simplified
while (running) {
  const outcome = await getUpdates(token, offset)
  if (outcome.kind === 'ok') {
    for (const update of outcome.updates) {
      offset = update.update_id + 1
      await handleUpdate(update)
    }
  } else {
    await delay(backoff.nextDelayMs())  // typed backoff per failure kind
  }
}
```

### Failure Classification

| Failure kind | Meaning | Retry? |
|---|---|---|
| `network` | DNS, timeout, offline | ✅ Yes, backoff |
| `backend-unavailable` | 5xx from backend | ✅ Yes, backoff |
| `rate-limited` | 429 | ✅ Yes, after delay |
| `telegram-error` | 4xx from Telegram | ✅ Yes, backoff |
| `auth` | No session / 401 | ❌ No — user must sign in |
| `unlinked` | Backend says no link | ❌ No — tear down bridge |

### Single-Session Lock

Only **one** `rayu-cli` process runs the bridge at a time:

```
telegram-bridge.lock  =  "PID:STARTTIME:HEARTBEAT_MS"
```

- **Acquired** via `O_EXCL` (atomic create-if-not-exists)
- **Heartbeat** refreshed every 10s
- **Stale after** 30s → another session can take over
- **PID reuse detection** via `/proc/<pid>/stat` start time (Linux)
- **Released** on process exit (any reason — SIGKILL, crash, normal exit)

If a second session tries to start the bridge, it gets a **no-op handle** — it can still be driven *through* the leader via IPC.

---

## 6. Message Routing (Multi-Session)

### The Problem

A user may have **multiple CLI sessions** open. The bridge leader (one process) owns the Telegram transport. The session the user wants to drive may be a **different process**.

### The Solution: Leader + IPC

```
┌────────────────────────────────────────────────────────┐
│  Session A (leader)                                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Bridge loop (getUpdates → handleUpdate)           │  │
│  │                                                   │  │
│  │  routePrompt(text)                                │  │
│  │    ├─ if attached session IS this process →       │  │
│  │    │   enqueue() directly (fast path)             │  │
│  │    └─ if attached session is ANOTHER process →    │  │
│  │        ensureLeaderLink() → IPC → session B       │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
                           │
                           │ IPC (persistent connection)
                           ▼
┌────────────────────────────────────────────────────────┐
│  Session B (follower)                                   │
│  ┌──────────────────────────────────────────────────┐  │
│  │ REPL queue ← receives prompt via IPC              │  │
│  │                                                   │  │
│  │ Streams back:                                     │  │
│  │   IPC_STREAM_DELTA  → leader → Telegram           │  │
│  │   IPC_STREAM_END    → leader → finalize           │  │
│  │   IPC_PERMISSION_*  → leader → Telegram card      │  │
│  │   IPC_ACTIVITY      → leader → Telegram           │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### Attachment vs. Addressability

- **Attached session** — the one receiving chat prompts (exactly one)
- **Addressable sessions** — all sessions with an IPC listener (can be targeted by lifecycle ops like restart/uninstall)

Persisted in `telegram-attached.json` so a new leader inherits the routing decision.

### Auto-Attach Memory

When a session is attached, `autoAttach` is saved (`sessionId`, `cwd`, timestamp). On CLI restart, if the remembered session is still alive, the bridge reconnects automatically (7-day TTL).

---

## 7. Inbound Message Handling

When a message arrives, it goes through this decision tree:

```
Message received
  │
  ├─ Is it a callback_query (inline keyboard tap)?
  │   ├─ chatId !== linkedChatId → answerCallbackQuery, ignore
  │   ├─ "q:" prefix → AskUserQuestion interview
  │   ├─ "pl:" prefix → plan approval
  │   ├─ "int:" prefix → interrupt (stop turn)
  │   ├─ "perm:" prefix → permission decision
  │   ├─ "unin:cancel" → cancel uninstall
  │   └─ other → wizard handler
  │
  ├─ Is it a photo/sticker/document?
  │   ├─ chatId !== linkedChatId → ignore
  │   └─ Download → build image command → deliver to session
  │
  ├─ Is it text?
  │   ├─ /link or /start → pairing flow
  │   ├─ /disconnect or /stop → unlink
  │   ├─ chatId !== linkedChatId → ignore
  │   ├─ /interrupt → stop running turn
  │   ├─ Open interactive card? → claim the message
  │   ├─ /connect, /model, /provider → built-in wizard
  │   ├─ /sessions, /switch, /status → bridge answers directly
  │   ├─ /uninstall → device lifecycle (typed operation)
  │   ├─ Other /command → check blocked list → deliver to REPL
  │   └─ Plain text → deliver to REPL as new turn
  │
  └─ Non-private chat? → revoke link (security)
```

### Command Blocking

Commands are blocked from Telegram if they:
1. Are in `TELEGRAM_SEMANTIC_HAZARDS` (`logout`, `telegram-remote-uninstall`)
2. Have type `local-jsx` (render interactive terminal UI)
3. Have `supportsNonInteractive: false` (need a real terminal)

The remaining commands are registered with Telegram's `setMyCommands` for autocomplete.

---

## 8. Outbound Streaming (CLI → Telegram)

When the AI streams a response, the bridge mirrors it to Telegram in real time:

```
Session streams token
  │
  ├─ startTurn()
  │   └─ new StreamingMirror → sendMessage("▒") → get messageId
  │
  ├─ onTextDelta(delta)
  │   └─ mirror.append(delta) → editMessageText(messageId, accumulated)
  │
  ├─ onThinkingDelta(delta)
  │   └─ sendChatAction("typing") — just an indicator, no content
  │
  └─ endTurn()
      └─ mirror.finalize() → final editMessageText
```

After the turn, `pushActivity()` edits the streamed message to prepend a summary (💭 thinking, 🔧 tools used, ❌ errors) — so the final message is one combined card.

---

## 9. Security Model

| Layer | Mechanism |
|---|---|
| **Pairing** | 96-bit random token, 10-min TTL, 5-guess limit, private-chat only |
| **Chat binding** | Only `linkedChatId` can drive the CLI |
| **Non-private revocation** | Links in groups/supergroups are auto-revoked |
| **Command blocking** | Terminal-only commands blocked from Telegram |
| **Semantic hazards** | `logout`, `telegram-remote-uninstall` blocked from Telegram |
| **Single-session lock** | PID + heartbeat lock prevents two bridge instances |
| **Remote uninstall** | Separate opt-in, 4-gate model (see §10) |
| **File access** | Only images accepted; code/text must be pasted |
| **Config permissions** | `telegram.json` is `0600` (owner-read-write only) |

---

## 10. Remote Uninstall (Separate Feature)

A **separate** safety switch (`/telegram-remote-uninstall on/off`) that gates whether `/uninstall` from Telegram can wipe the CLI. Four independent gates:

1. **Local opt-in** — default off, settable only at terminal (blocked from Telegram)
2. **Device targeting** — must name which machine (no bare `/uninstall`)
3. **Confirmation code** — 6-char, 90s TTL, bound to user+chat+device, 3-guess limit
4. **Concurrency lock** — device marked `uninstalling` before anything is destroyed

**Removes:** CLI binary, config, saved API keys
**Never touches:** projects, source code, git repos

---

## 11. Key Files Map

| File | Role |
|---|---|
| `src/telegram/telegramBridge.ts` | **Core bridge loop** — polling, message routing, streaming mirror, lock |
| `src/telegram/telegramConfig.ts` | **Config layer** — `telegram.json` read/write, pairing token, chat binding |
| `src/telegram/telegramApi.ts` | **Telegram Bot API client** — `fetch`-based, typed errors, `HostedRouter` seam |
| `src/telegram/telegramHostedApi.ts` | **Backend client** — JWT-authed calls to `rayu-backend` `/telegram/*` |
| `src/telegram/telegramTransport.ts` | **Hosted transport** — adapts backend to `HostedRouter` seam |
| `src/telegram/telegramRouter.ts` | **Prompt router** — routes inbound prompts to attached session (in-process or IPC) |
| `src/telegram/telegramAttach.ts` | **Attachment state** — `telegram-attached.json`, which session receives prompts |
| `src/telegram/telegramLeaderLink.ts` | **Cross-process link** — persistent IPC to follower session |
| `src/telegram/telegramRemoteBridge.ts` | **IPC message types** — `IPC_PROMPT`, `IPC_STREAM_*`, `IPC_PERMISSION_*` |
| `src/telegram/telegramConnect.ts` | **/connect wizard** — provider/model picker over Telegram |
| `src/telegram/telegramSessions.ts` | **Session management** — `/sessions`, `/switch`, `/status` |
| `src/telegram/telegramPermissions.ts` | **Permission cards** — inline keyboard for tool approval |
| `src/telegram/telegramUninstall.ts` | **Remote uninstall** — 4-gate uninstall flow |
| `src/telegram/telegramChatGuard.ts` | **Chat type guard** — revoke links in non-private chats |
| `src/telegram/telegramHealth.ts` | **Health reporting** — bridge start/stop, poll success/failure |
| `src/telegram/streamingMirror.ts` | **Streaming mirror** — live-edits Telegram message with AI output |
| `src/telegram/telegramMarkdown.ts` | **Markdown renderer** — CLI markdown → Telegram HTML |
| `src/telegram/telegramMedia.ts` | **Media handling** — image albums, file downloads |
| `src/telegram/telegramInterrupt.ts` | **Interrupt handling** — ⛔ Stop card, `/interrupt` command |
| `src/telegram/telegramPlanApproval.ts` | **Plan approval** — approve/reject plan mode from Telegram |
| `src/telegram/telegramQuestions.ts` | **AskUserQuestion** — interactive interview cards |
| `src/telegram/telegramModelCatalog.ts` | **Model catalog** — `/model` picker data |
| `src/telegram/telegramSnapshot.ts` | **Session snapshot** — publishes session list for Mini App |
| `src/commands/telegram-bot/index.ts` | **Connect UI** — QR code, hosted/BYO chooser |
| `src/commands/telegram-bot/remote-uninstall.ts` | **Uninstall opt-in** — local toggle for remote uninstall |

---

## 12. Data Flow Summary

```
User on Telegram
  │
  │  sends message
  ▼
Telegram Server
  │
  │  getUpdates (long-poll)
  ▼
rayu-cli (bridge leader)
  │
  │  handleUpdate()
  │  ├─ parse command
  │  ├─ check chat binding
  │  ├─ route to REPL queue (in-process or IPC)
  │  └─ show stop card
  ▼
CLI Session (REPL)
  │
  │  runs AI turn, streams tokens
  ▼
Bridge (streaming mirror)
  │
  │  editMessageText (live)
  ▼
Telegram Server → User sees streaming response
```

---

## 13. Key Patterns for a Web App Equivalent

If you're building a web app connection, these patterns from the Telegram bridge are worth reusing:

| Pattern | Telegram Implementation | Web App Equivalent |
|---|---|---|
| **Pairing** | 96-bit token via `/start` | One-time code or QR → WebSocket claim |
| **Transport abstraction** | `HostedRouter` seam (direct vs. backend-relay) | WebSocket (direct) vs. backend-relayed SSE |
| **Single-session lock** | PID + heartbeat file lock | Redis lock or DB row with TTL |
| **Multi-session routing** | `telegram-attached.json` + IPC | Session registry + WebSocket routing |
| **Streaming** | `editMessageText` live edits | SSE or WebSocket push |
| **Command blocking** | `isBlockedFromTelegram()` | Web-safe command filter |
| **Permission cards** | Inline keyboard | In-app modal/notification |
| **Auto-reconnect** | `autoAttach` with 7-day TTL | Refresh token + session resume |
| **Failure classification** | Typed `PollOutcome` | Typed connection state machine |
| **Config isolation** | `0600` file per config | Encrypted storage, per-user keys |

---

*Document generated from source code in `src/telegram/` and `src/commands/telegram-bot/`.*
