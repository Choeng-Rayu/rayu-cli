import { toString as qrToString } from 'qrcode'
import { randomBytes } from 'crypto'
import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  clearBotToken,
  getBotToken,
  getTelegramMode,
  isValidBotToken,
  normalizeBotToken,
  readTelegramConfig,
  saveBotToken,
  setLinkedBotUsername,
  setLinkedChat,
  setPendingToken,
  setTelegramMode,
  telegramTransportKey,
  unlink,
} from '../../telegram/telegramConfig.js'
import { getBotUsername } from '../../telegram/telegramApi.js'
import {
  createHostedPairing,
  deleteHostedLink,
  getHostedBotInfo,
  getHostedLink,
  type HostedPairing,
} from '../../telegram/telegramHostedApi.js'
import { hasRayuSession } from '../../services/rayuAuth/rayuSession.js'
import { useSetAppState } from '../../state/AppState.js'

/** The AppState updater handed out by useSetAppState(). */
type SetAppState = ReturnType<typeof useSetAppState>

const TOKEN_TTL_MS = 10 * 60 * 1000

interface Props {
  onDone: () => void
}

/**
 * Listen for a single keypress. Uses Ink's parsed input rather than a raw
 * `process.stdin` 'data' listener: Ink owns stdin (raw mode + a 'readable'
 * consumer), so a second raw listener competes with it and sees transport-level
 * chunks (escape sequences, per-keystroke fragments) instead of keys.
 */
/**
 * Turn the bridge on for the bot currently in config.
 *
 * Publishing `telegramTransportKey` alongside the flag is what lets
 * useTelegramBridge notice that the transport changed (own bot ⇄ shared bot, or
 * a different bot) and rebuild instead of keeping the previous bot's token.
 * Every activation path must go through here.
 */
function activateBridge(setAppState: SetAppState): void {
  const key = telegramTransportKey()
  setAppState((prev) => ({
    ...prev,
    telegramBridgeActive: true,
    telegramTransportKey: key,
  }))
}

function useKeyPress(target: string, handler: () => void): void {
  useInput(input => {
    if (input.trim().toLowerCase() === target) handler()
  })
}

/**
 * Esc backs out of the connect flow. Every screen wires this up: the QR screens
 * poll indefinitely, so without it the only way out was Ctrl+C (which kills the
 * whole session).
 */
function useEscapeToCancel(onCancel: () => void): void {
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })
}

/** Shared footer so the cancel key is discoverable on every screen. */
function CancelHint(): React.ReactNode {
  return (
    <Text dimColor>
      Press <Text bold>Esc</Text> to cancel.
    </Text>
  )
}

/**
 * DEFAULT step: connect via the shared Rayu-hosted bot — no bot token needed.
 * Fetches a pairing code from the backend, shows a QR/deep-link to the shared
 * bot, and polls the backend for the link. Press "b" to bring your own token.
 */
function HostedStep({
  onDone,
  onUseByo,
  onCancel,
}: {
  onDone: () => void
  onUseByo: () => void
  onCancel: () => void
}): React.ReactNode {
  const [status, setStatus] = useState<
    'loading' | 'ready' | 'unconfigured' | 'error' | 'nosession'
  >('loading')
  const [pairing, setPairing] = useState<HostedPairing | null>(null)
  const [qr, setQr] = useState('')
  const setAppState = useSetAppState()

  useKeyPress('b', onUseByo)
  useEscapeToCancel(onCancel)

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
        // Record the bot this link belongs to. The default bot's identity is
        // owned by the backend, so this is the only way a later connect can
        // tell that the deployment has moved to a different bot.
        if (link.chatId) {
          setLinkedChat(
            Number(link.chatId),
            link.username ?? undefined,
            pairing?.botUsername ?? undefined,
          )
        } else if (pairing?.botUsername) {
          setLinkedBotUsername(pairing.botUsername)
        }
        activateBridge(setAppState)
        onDone()
      })
    }, 1500)
    return () => clearInterval(timer)
  }, [status, onDone, setAppState, pairing])

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
          <CancelHint />
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
          <CancelHint />
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
        <CancelHint />
      </Box>
    </Pane>
  )
}

/**
 * BYO management step. Lets the user CRUD their own @BotFather token:
 *  - none saved → paste a token (Create).
 *  - already saved → [Enter] connect with it, [r] Replace it, [d] Delete it
 *    (e.g. the old one expired/was revoked).
 * Selecting this path pins the mode to 'byo' (direct CLI ↔ Telegram, no backend).
 *
 * Input is handled by the shared TextInput component (Ink's parsed input),
 * never by a raw `process.stdin` 'data' listener. That distinction is the whole
 * bug this replaced: Ink puts stdin in RAW mode, so a 'data' handler receives
 * one event per keystroke (plus the ESC[200~/ESC[201~ bracketed-paste guards
 * around a paste). The old code treated every one of those chunks as a
 * finished line and regex-tested it, so the very first character typed — or
 * the paste's leading escape sequence — was reported as "not a valid bot
 * token" before the user had entered anything. Validation now happens once, on
 * submit.
 */
function TokenInputStep({
  onReady,
  onCancel,
}: {
  onReady: () => void
  onCancel: () => void
}): React.ReactNode {
  const [existing, setExisting] = useState<string | undefined>(() => getBotToken())
  // When a token is already stored, start on the manage menu instead of the
  // prompt so 'd'/'r' are commands rather than characters typed into a field.
  const [editing, setEditing] = useState(() => getBotToken() === undefined)

  const connect = useCallback(() => {
    setTelegramMode('byo')
    onReady()
  }, [onReady])

  if (existing && !editing) {
    return (
      <ExistingTokenMenu
        token={existing}
        onConnect={connect}
        onReplace={() => setEditing(true)}
        onDelete={() => {
          clearBotToken()
          setExisting(undefined)
          setEditing(true)
        }}
        onCancel={onCancel}
      />
    )
  }

  return (
    <TokenPrompt
      hasExisting={existing !== undefined}
      onSaved={connect}
      onCancel={onCancel}
      onCancelReplace={existing !== undefined ? () => setEditing(false) : undefined}
    />
  )
}

/** A token is already stored → keep / replace / delete. */
function ExistingTokenMenu({
  token,
  onConnect,
  onReplace,
  onDelete,
  onCancel,
}: {
  token: string
  onConnect: () => void
  onReplace: () => void
  onDelete: () => void
  onCancel: () => void
}): React.ReactNode {
  useEscapeToCancel(onCancel)
  useInput((input, key) => {
    if (key.return) {
      onConnect()
      return
    }
    const ch = input.trim().toLowerCase()
    if (ch === '1') onConnect()
    else if (ch === '2' || ch === 'r') onReplace()
    else if (ch === '3' || ch === 'd') onDelete()
  })

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Your Telegram bot token</Text>
        <Text> </Text>
        <Text>A bot token is already saved (…{token.slice(-6)}).</Text>
        <Text> </Text>
        <Text>
          <Text bold>Enter</Text> connect with it{'   '}
          <Text bold>r</Text> replace it{'   '}
          <Text bold>d</Text> remove it
        </Text>
        <CancelHint />
      </Box>
    </Pane>
  )
}

/**
 * The actual "paste your token" field. Validates the token's shape on submit,
 * then confirms it with Telegram's getMe before saving — a syntactically valid
 * but revoked/mistyped token would otherwise be accepted here and only fail
 * later as a silent hang on the "waiting for link" screen.
 */
function TokenPrompt({
  hasExisting,
  onSaved,
  onCancel,
  onCancelReplace,
}: {
  hasExisting: boolean
  onSaved: () => void
  onCancel: () => void
  onCancelReplace?: () => void
}): React.ReactNode {
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<'idle' | 'verifying' | 'saved'>('idle')

  // Esc goes back to the manage menu when replacing an existing token, and
  // otherwise abandons the connect flow entirely.
  useInput(
    (_input, key) => {
      if (!key.escape) return
      if (onCancelReplace) onCancelReplace()
      else onCancel()
    },
    { isActive: status === 'idle' },
  )

  const handleSubmit = useCallback(
    (submitted: string) => {
      if (status !== 'idle') return
      const token = normalizeBotToken(submitted)
      if (!token) {
        setError('Paste the token from @BotFather, then press Enter.')
        return
      }
      if (!isValidBotToken(token)) {
        setError(
          "That doesn't look like a bot token. It should be like: 123456789:ABCDefGHI…",
        )
        return
      }
      setError('')
      setStatus('verifying')
      void getBotUsername(token).then(username => {
        if (!username) {
          setStatus('idle')
          setError(
            'Telegram rejected this token. Check it in @BotFather (or /revoke and paste the new one).',
          )
          return
        }
        saveBotToken(token)
        setTelegramMode('byo')
        setStatus('saved')
        setTimeout(onSaved, 300)
      })
    },
    [status, onSaved],
  )

  if (status === 'saved') {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text color="green">✅ Bot token saved!</Text>
          <Text dimColor>Connecting…</Text>
        </Box>
      </Pane>
    )
  }

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>
          {hasExisting
            ? '📱 Replace your Telegram bot token'
            : '📱 Connect your own Telegram bot'}
        </Text>
        <Text> </Text>
        <Text bold>Steps:</Text>
        <Text>  1. Open Telegram and search for <Text bold>@BotFather</Text></Text>
        <Text>  2. Send <Text bold>/newbot</Text> and follow the prompts</Text>
        <Text>  3. Copy the bot token (looks like: 123456789:ABCDef...)</Text>
        <Text>  4. Paste it below and press <Text bold>Enter</Text>:</Text>
        <Text> </Text>
        <Box>
          <Text bold color="cyan">⌨ Bot token: </Text>
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            columns={80}
            focus={status === 'idle'}
            showCursor
          />
        </Box>
        {status === 'verifying' ? (
          <Text dimColor>Checking the token with Telegram…</Text>
        ) : null}
        {error ? <Text color="red">{error}</Text> : null}
        {onCancelReplace ? (
          <Text dimColor>Press Esc to keep the token you already have.</Text>
        ) : (
          <CancelHint />
        )}
      </Box>
    </Pane>
  )
}

/**
 * BYO step 2: token exists — show a QR for linking, auto-close once linked.
 * The CLI itself polls Telegram and consumes the /start in this mode.
 */
function LinkStep({
  onDone,
  onCancel,
}: {
  onDone: () => void
  onCancel: () => void
}): React.ReactNode {
  const token = getBotToken()!
  // Pairing token = the ONLY gate on linking a chat to this CLI, and a linked
  // chat can drive the agent (including Bash via tool approval). It used to be
  // randomUUID().slice(0, 8) — 32 bits, and the bot that accepts it is publicly
  // addressable. 96 bits keeps it short enough to retype while removing any
  // guessing margin. base64url so it is safe in a t.me/?start= deep link.
  const [pairToken] = useState(() => randomBytes(12).toString('base64url'))
  const [qr, setQr] = useState('')
  const [botUsername, setBotUsername] = useState<string | undefined>(undefined)
  const setAppState = useSetAppState()

  useEscapeToCancel(onCancel)

  useEffect(() => {
    saveBotToken(token)
    // The bridge has to be running to receive the user's /start, so it is
    // activated before the link exists. Cancelling therefore has to turn it
    // back off — see TelegramBotConnect's cancel handler.
    activateBridge(setAppState)
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
        // consumePendingToken() (in the bridge) writes the chat binding but has
        // no way to know the bot's @username — record it here so a later
        // connect can detect a bot change instead of reusing a stale link.
        if (botUsername) setLinkedBotUsername(botUsername)
        // NOTE: deliberately no activateBridge() here. The bridge is already
        // running on this exact bot (started on mount to receive the /start) and
        // resolves the chat id dynamically, so there is nothing to rebuild —
        // restarting it here would abandon the un-confirmed /start update and
        // make Telegram redeliver it to the new instance.
        onDone()
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [onDone, botUsername])

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
        <CancelHint />
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
  onCancel,
}: {
  onChoose: (mode: 'hosted' | 'byo') => void
  onCancel: () => void
}): React.ReactNode {
  const [sel, setSel] = useState<0 | 1>(0) // 0 = shared (default), 1 = own bot

  useEscapeToCancel(onCancel)
  useInput((input, key) => {
    const t = input.trim()
    if (t === '1') onChoose('hosted')
    else if (t === '2') onChoose('byo')
    else if (key.return) onChoose(sel === 0 ? 'hosted' : 'byo')
    else if (key.upArrow || key.downArrow || t === 'j' || t === 'k') {
      setSel(p => (p === 0 ? 1 : 0))
    }
  })

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
        <CancelHint />
      </Box>
    </Pane>
  )
}

/**
 * Resolve the @username of the bot the CLI would use RIGHT NOW.
 *
 * Hosted/default mode has no bot identity in local config at all — the shared
 * bot is whatever RAYU_SHARED_BOT_TOKEN on the backend points at, so it has to
 * be asked. BYO mode resolves from the user's own stored token via getMe.
 * Returns undefined when it can't be determined (offline, signed out, backend
 * down); callers must treat that as "unknown", never as "changed".
 */
async function resolveCurrentBotUsername(): Promise<string | undefined> {
  if (getTelegramMode() === 'hosted') {
    if (!hasRayuSession()) return undefined
    const info = await getHostedBotInfo()
    return info.username ?? undefined
  }
  const token = getBotToken()
  return token ? await getBotUsername(token) : undefined
}

type LinkCheck =
  | { kind: 'checking' }
  /** Stored link was made with a different bot than the one in use now. */
  | { kind: 'changed'; linkedTo: string; current: string }
  /** Link predates bot-identity tracking — can't prove which bot it belongs to. */
  | { kind: 'unverifiable'; current: string }

/**
 * Guard in front of the "already linked, just reconnect" fast path.
 *
 * The old fast path reactivated any stored `linkedChatId` unconditionally and
 * closed immediately. That is why users stayed on a retired default bot: the
 * connect command had no branch that could ever re-pair, and the local config
 * recorded nothing about WHICH bot the link belonged to, so a backend switch to
 * a different shared bot was invisible here. Now the stored link is only reused
 * when the bot it was made with still matches the live one.
 */
function VerifyLinkStep({
  onReconnect,
  onRepair,
  onCancel,
}: {
  onReconnect: () => void
  onRepair: () => void
  onCancel: () => void
}): React.ReactNode {
  const [check, setCheck] = useState<LinkCheck>({ kind: 'checking' })

  useEscapeToCancel(onCancel)
  useInput(
    (input, key) => {
      if (check.kind === 'checking') return
      if (key.return) {
        // For a confirmed bot change there is nothing to reconnect TO, so Enter
        // means "re-pair"; for an unverifiable link it means "use it anyway".
        if (check.kind === 'changed') onRepair()
        else {
          // Backfill so this prompt appears at most once per link.
          setLinkedBotUsername(check.current)
          onReconnect()
        }
        return
      }
      if (input.trim().toLowerCase() === 'r') onRepair()
    },
    { isActive: check.kind !== 'checking' },
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const recorded = readTelegramConfig().linkedBotUsername
      const current = await resolveCurrentBotUsername()
      if (cancelled) return
      // Unknown live bot (offline/backend hiccup): keep the stored link rather
      // than forcing someone offline to re-pair.
      if (!current) {
        onReconnect()
        return
      }
      if (recorded && recorded.toLowerCase() === current.toLowerCase()) {
        onReconnect()
        return
      }
      setCheck(
        recorded
          ? { kind: 'changed', linkedTo: recorded, current }
          : { kind: 'unverifiable', current },
      )
    })()
    return () => {
      cancelled = true
    }
  }, [onReconnect])

  if (check.kind === 'checking') {
    return (
      <Pane>
        <Text dimColor>Reconnecting Telegram…</Text>
      </Pane>
    )
  }

  if (check.kind === 'changed') {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold>📱 Telegram bot changed</Text>
          <Text> </Text>
          <Text>
            Your saved link points at <Text bold>@{check.linkedTo}</Text>, but Rayu
            now uses <Text bold>@{check.current}</Text>.
          </Text>
          <Text dimColor>The old link can't receive messages from the new bot.</Text>
          <Text> </Text>
          <Text>
            <Text bold>Enter</Text> link with @{check.current}
          </Text>
          <CancelHint />
        </Box>
      </Pane>
    )
  }

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Telegram is already linked</Text>
        <Text> </Text>
        <Text>
          Rayu currently uses <Text bold>@{check.current}</Text>.
        </Text>
        <Text dimColor>
          This link was saved before Rayu recorded which bot it belongs to, so it
          may point at an older bot.
        </Text>
        <Text> </Text>
        <Text>
          <Text bold>Enter</Text> reconnect with the saved link{'   '}
          <Text bold>r</Text> re-link with @{check.current}
        </Text>
        <CancelHint />
      </Box>
    </Pane>
  )
}

/**
 * Router. If a link from a previous session exists, verify it still belongs to
 * the bot in use before reusing it (see VerifyLinkStep); otherwise show the
 * explicit chooser, then route to the hosted (default, no token) or BYO flow.
 * The two modes are mutually exclusive — the chosen mode is pinned via
 * setTelegramMode() so the bridge only ever uses ONE transport (no dual
 * connect: shared goes through the backend, BYO goes direct to Telegram).
 *
 * Esc cancels from any screen.
 */
function TelegramBotConnect({ onDone }: Props): React.ReactNode {
  const setAppState = useSetAppState()
  const [screen, setScreen] = useState<
    'verify' | 'choose' | 'hosted' | 'byo-token' | 'byo-link'
  >(() => (readTelegramConfig().linkedChatId === undefined ? 'choose' : 'verify'))
  const [unlinking, setUnlinking] = useState(false)

  const reconnect = useCallback(() => {
    activateBridge(setAppState)
    onDone()
  }, [onDone, setAppState])

  // Re-pairing must drop the stale binding first — locally, because the pairing
  // screens close as soon as a linkedChatId appears, and server-side in hosted
  // mode, because HostedStep polls /telegram/link and would otherwise see the
  // OLD link row as an instant success and never show a QR at all.
  const repair = useCallback(() => {
    setUnlinking(true)
    void (async () => {
      if (getTelegramMode() === 'hosted') await deleteHostedLink()
      unlink()
      setUnlinking(false)
      setScreen('choose')
    })()
  }, [])

  // LinkStep/HostedStep can enable the bridge before a link exists (the bridge
  // is what receives the user's /start), so backing out has to switch it off
  // again rather than leaving a half-connected session behind.
  const cancel = useCallback(() => {
    setAppState((prev) => ({ ...prev, telegramBridgeActive: false }))
    onDone()
  }, [onDone, setAppState])

  if (unlinking) {
    return (
      <Pane>
        <Text dimColor>Removing the old Telegram link…</Text>
      </Pane>
    )
  }

  if (screen === 'verify') {
    return (
      <VerifyLinkStep
        onReconnect={reconnect}
        onRepair={repair}
        onCancel={cancel}
      />
    )
  }

  if (screen === 'choose') {
    return (
      <ChooseModeStep
        onCancel={cancel}
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
    return (
      <HostedStep
        onDone={onDone}
        onUseByo={() => setScreen('byo-token')}
        onCancel={cancel}
      />
    )
  }
  if (screen === 'byo-token') {
    return (
      <TokenInputStep onReady={() => setScreen('byo-link')} onCancel={cancel} />
    )
  }
  return <LinkStep onDone={onDone} onCancel={cancel} />
}

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <TelegramBotConnect onDone={onDone} />
}
