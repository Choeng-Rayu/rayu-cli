// @ts-expect-error — qrcode ships without bundled types; works at runtime
import { toString as qrToString } from 'qrcode'
import { randomUUID } from 'crypto'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  clearBotToken,
  getBotToken,
  readTelegramConfig,
  saveBotToken,
  setLinkedChat,
  setPendingToken,
  setTelegramMode,
} from '../../telegram/telegramConfig.js'
import { getBotUsername } from '../../telegram/telegramApi.js'
import {
  createHostedPairing,
  getHostedBotInfo,
  getHostedLink,
  type HostedPairing,
} from '../../telegram/telegramHostedApi.js'
import { hasRayuSession } from '../../services/rayuAuth/rayuSession.js'
import { useSetAppState } from '../../state/AppState.js'

const TOKEN_TTL_MS = 10 * 60 * 1000

interface Props {
  onDone: () => void
}

/** Listen for a single keypress (first char of a stdin line). */
function useKeyPress(target: string, handler: () => void): void {
  useEffect(() => {
    const onData = (data: Buffer): void => {
      const ch = data.toString().trim().toLowerCase()
      if (ch === target) handler()
    }
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
    }
  }, [target, handler])
}

/**
 * DEFAULT step: connect via the shared Rayu-hosted bot — no bot token needed.
 * Fetches a pairing code from the backend, shows a QR/deep-link to the shared
 * bot, and polls the backend for the link. Press "b" to bring your own token.
 */
function HostedStep({
  onDone,
  onUseByo,
}: {
  onDone: () => void
  onUseByo: () => void
}): React.ReactNode {
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'unconfigured' | 'error' | 'nosession'
  >('loading')
  const [pairing, setPairing] = useState<HostedPairing | null>(null)
  const [qr, setQr] = useState('')
  const setAppState = useSetAppState()

  useKeyPress('b', onUseByo)

  // Fetch shared-bot info + a pairing code on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!hasRayuSession()) {
        if (!cancelled) setStatus('nosession')
        return
      }
      const info = await getHostedBotInfo()
      if (cancelled) return
      if (!info.configured) {
        setStatus('unconfigured')
        return
      }
      const p = await createHostedPairing()
      if (cancelled) return
      if (!p) {
        setStatus('error')
        return
      }
      setTelegramMode('hosted')
      setPairing(p)
      setStatus('ready')
      if (p.deepLink) {
        try {
          setQr(await qrToString(p.deepLink, { type: 'utf8', errorCorrectionLevel: 'L' }))
        } catch {
          // QR is optional — the code + link are still shown.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Poll the backend for the link, then activate the bridge and close.
  useEffect(() => {
    if (status !== 'ready') return
    const timer = setInterval(() => {
      void getHostedLink().then((link) => {
        if (!link.linked) return
        clearInterval(timer)
        if (link.chatId) setLinkedChat(Number(link.chatId), link.username ?? undefined)
        setAppState((prev) => ({ ...prev, telegramBridgeActive: true }))
        onDone()
      })
    }, 1500)
    return () => clearInterval(timer)
  }, [status, onDone, setAppState])

  if (status === 'loading') {
    return (
      <Pane>
        <Text dimColor>Connecting to the Rayu Telegram bot…</Text>
      </Pane>
    )
  }

  if (status === 'nosession') {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold>📱 Connect Telegram</Text>
          <Text> </Text>
          <Text color="yellow">Sign in first: run /login to use the shared Rayu bot.</Text>
          <Text> </Text>
          <Text dimColor>Or press <Text bold>b</Text> to connect your own bot token instead.</Text>
        </Box>
      </Pane>
    )
  }

  if (status === 'unconfigured' || status === 'error') {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold>📱 Connect Telegram</Text>
          <Text> </Text>
          <Text color="yellow">
            {status === 'unconfigured'
              ? "The shared Rayu Telegram bot isn't available right now."
              : "Couldn't reach the Rayu Telegram service."}
          </Text>
          <Text> </Text>
          <Text>Press <Text bold>b</Text> to connect your own bot token instead.</Text>
        </Box>
      </Pane>
    )
  }

  // status === 'ready'
  const lines = qr.split('\n').filter((l) => l.length > 0)
  const bot = pairing?.botUsername
  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Connect Telegram (Rayu bot — no setup needed)</Text>
        <Text> </Text>
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text> </Text>
        <Text>
          Scan the QR{bot ? ` to open @${bot}` : ''}, or open the bot and send:
        </Text>
        <Text bold>  /start {pairing?.code}</Text>
        <Text> </Text>
        <Text dimColor>Waiting for you to link… (code valid 10 min)</Text>
        <Text dimColor>Press <Text bold>b</Text> to use your own bot token instead.</Text>
      </Box>
    </Pane>
  )
}

/**
 * BYO management step. Lets the user CRUD their own @BotFather token:
 *  - none saved → paste a token (Create).
 *  - already saved → [Enter] connect with it, paste a NEW token to Replace,
 *    or [d] Delete it (e.g. the old one expired/was revoked).
 * Selecting this path pins the mode to 'byo' (direct CLI ↔ Telegram, no backend).
 */
function TokenInputStep({ onReady }: { onReady: () => void }): React.ReactNode {
  const [existing, setExisting] = useState<string | undefined>(() => getBotToken())
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    const handler = (data: Buffer): void => {
      const line = data.toString().trim()
      // With a token already saved: Enter = keep & connect, 'd' = delete.
      if (existing) {
        if (line === '') {
          setTelegramMode('byo')
          onReady()
          return
        }
        if (line.toLowerCase() === 'd') {
          clearBotToken()
          setExisting(undefined)
          setError('')
          return
        }
        // anything else falls through and is treated as a NEW token to replace.
      }
      if (!line) return
      if (/^\d+:[A-Za-z0-9_-]+$/.test(line)) {
        saveBotToken(line)
        setTelegramMode('byo')
        setWaiting(true)
        setTimeout(() => onReady(), 300)
      } else {
        setError("That doesn't look like a valid bot token. It should be like: 123456789:ABCDefGHI...")
      }
    }
    process.stdin.on('data', handler)
    return () => {
      process.stdin.off('data', handler)
    }
  }, [existing, onReady])

  if (waiting) {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text color="green">✅ Bot token saved!</Text>
          <Text dimColor>Connecting…</Text>
        </Box>
      </Pane>
    )
  }

  // A token is already stored → offer keep / replace / delete.
  if (existing) {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold>📱 Your Telegram bot token</Text>
          <Text> </Text>
          <Text>A bot token is already saved (…{existing.slice(-6)}).</Text>
          <Text> </Text>
          <Text>
            <Text bold>Enter</Text> connect with it{'   '}
            <Text bold>d</Text> remove it{'   '}
            or paste a <Text bold>new</Text> token to replace it.
          </Text>
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      </Pane>
    )
  }

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Connect your own Telegram bot</Text>
        <Text> </Text>
        <Text bold>Steps:</Text>
        <Text>  1. Open Telegram and search for <Text bold>@BotFather</Text></Text>
        <Text>  2. Send <Text bold>/newbot</Text> and follow the prompts</Text>
        <Text>  3. Copy the bot token (looks like: 123456789:ABCDef...)</Text>
        <Text>  4. Paste it below:</Text>
        <Text> </Text>
        <Text bold color="cyan">⌨ Paste your bot token: </Text>
        {error ? <Text color="red">{error}</Text> : null}
      </Box>
    </Pane>
  )
}

/**
 * BYO step 2: token exists — show a QR for linking, auto-close once linked.
 * The CLI itself polls Telegram and consumes the /start in this mode.
 */
function LinkStep({ onDone }: Props): React.ReactNode {
  const token = getBotToken()!
  const [pairToken] = useState(() => randomUUID().slice(0, 8))
  const [qr, setQr] = useState('')
  const [botUsername, setBotUsername] = useState<string | undefined>(undefined)
  const setAppState = useSetAppState()

  useEffect(() => {
    saveBotToken(token)
    setAppState((prev) => ({ ...prev, telegramBridgeActive: true }))
    setPendingToken(pairToken, TOKEN_TTL_MS)
    void getBotUsername(token).then(async (name) => {
      setBotUsername(name)
      const deepLink = name ? `https://t.me/${name}?start=${pairToken}` : pairToken
      try {
        setQr(await qrToString(deepLink, { type: 'utf8', errorCorrectionLevel: 'L' }))
      } catch {
        // QR generation failed — token text is still shown
      }
    })
  }, [token, pairToken, setAppState])

  useEffect(() => {
    const timer = setInterval(() => {
      if (readTelegramConfig().linkedChatId !== undefined) {
        clearInterval(timer)
        onDone()
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [onDone])

  const lines = qr.split('\n').filter((l) => l.length > 0)
  return (
    <Pane>
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text> </Text>
        <Text>Scan the QR{botUsername ? ` to open @${botUsername}` : ''}, or send this to the bot:</Text>
        <Text bold>  /start {pairToken}</Text>
        <Text> </Text>
        <Text dimColor>Waiting for link… (token valid 10 min)</Text>
      </Box>
    </Pane>
  )
}

/**
 * FIRST screen: let the user explicitly choose how to connect. Default is the
 * shared Rayu bot (hosted, no setup); the alternative is their own @BotFather
 * token (private, connects the CLI directly to Telegram with no backend).
 */
function ChooseModeStep({
  onChoose,
}: {
  onChoose: (mode: 'hosted' | 'byo') => void
}): React.ReactNode {
  const [sel, setSel] = useState<0 | 1>(0) // 0 = shared (default), 1 = own bot

  useEffect(() => {
    const onData = (data: Buffer): void => {
      const s = data.toString()
      const t = s.trim()
      if (t === '1') onChoose('hosted')
      else if (t === '2') onChoose('byo')
      else if (s === '\r' || s === '\n' || t === '') onChoose(sel === 0 ? 'hosted' : 'byo')
      else if (s === '\u001b[A' || s === '\u001b[B' || t === 'j' || t === 'k') {
        setSel((p) => (p === 0 ? 1 : 0))
      }
    }
    process.stdin.on('data', onData)
    return () => {
      process.stdin.off('data', onData)
    }
  }, [onChoose, sel])

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Connect Telegram — choose how</Text>
        <Text> </Text>
        <Text color={sel === 0 ? 'cyan' : undefined}>
          {sel === 0 ? '▶ ' : '  '}1. Rayu shared bot{'  '}
          <Text dimColor>(recommended — no setup, hosted by Rayu)</Text>
        </Text>
        <Text color={sel === 1 ? 'cyan' : undefined}>
          {sel === 1 ? '▶ ' : '  '}2. Your own bot token{'  '}
          <Text dimColor>(private — direct to Telegram, no server)</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>Press 1 or 2 (or ↑/↓ then Enter). Enter = shared bot.</Text>
      </Box>
    </Pane>
  )
}

/**
 * Router. If already linked from a previous session, reactivate + close. Else
 * show the explicit chooser, then route to the hosted (shared) or BYO flow.
 * The two modes are mutually exclusive — the chosen mode is pinned via
 * setTelegramMode() so the bridge only ever uses ONE transport (no dual
 * connect: shared goes through the backend, BYO goes direct to Telegram).
 */
function TelegramBotConnect({ onDone }: Props): React.ReactNode {
  const alreadyLinked = readTelegramConfig().linkedChatId !== undefined
  const setAppState = useSetAppState()
  const [screen, setScreen] = useState<'choose' | 'hosted' | 'byo-token' | 'byo-link'>(
    'choose',
  )

  // Fast path: already linked → reactivate the bridge (it picks the stored
  // mode's transport) and close immediately.
  useEffect(() => {
    if (alreadyLinked) {
      setAppState((prev) => ({ ...prev, telegramBridgeActive: true }))
      onDone()
    }
  }, [alreadyLinked, onDone, setAppState])

  if (alreadyLinked) {
    return (
      <Pane>
        <Text dimColor>Reconnecting Telegram…</Text>
      </Pane>
    )
  }

  if (screen === 'choose') {
    return (
      <ChooseModeStep
        onChoose={(mode) => {
          if (mode === 'hosted') {
            setTelegramMode('hosted')
            setScreen('hosted')
          } else {
            setTelegramMode('byo')
            // Always go through the token manager so an existing token can be
            // kept, replaced, or deleted (CRUD) — not just used once.
            setScreen('byo-token')
          }
        }}
      />
    )
  }
  if (screen === 'hosted') {
    return <HostedStep onDone={onDone} onUseByo={() => setScreen('byo-token')} />
  }
  if (screen === 'byo-token') {
    return <TokenInputStep onReady={() => setScreen('byo-link')} />
  }
  return <LinkStep onDone={onDone} />
}

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <TelegramBotConnect onDone={onDone} />
}
