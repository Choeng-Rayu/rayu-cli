// @ts-expect-error — qrcode ships without bundled types; works at runtime
import { toString as qrToString } from 'qrcode'
import { randomUUID } from 'crypto'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getBotToken, saveBotToken, readTelegramConfig, setPendingToken } from '../../telegram/telegramConfig.js'
import { getBotUsername } from '../../telegram/telegramApi.js'
import { useSetAppState } from '../../state/AppState.js'

const TOKEN_TTL_MS = 10 * 60 * 1000

interface Props {
  onDone: () => void
}

/**
 * Step 1: No bot token configured — guide user through @BotFather and accept token input.
 */
function TokenInputStep({ onTokenSaved }: { onTokenSaved: () => void }): React.ReactNode {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    // Listen for stdin text input (raw line) to capture the bot token.
    const handler = (data: Buffer) => {
      const line = data.toString().trim()
      if (!line) return
      setInput(line)
      // Validate it looks like a bot token (format: 123456:ABC-DEF...)
      if (/^\d+:[A-Za-z0-9_-]+$/.test(line)) {
        setWaiting(true)
        saveBotToken(line)
        // Small delay for UX so user sees "Saved!"
        setTimeout(() => onTokenSaved(), 300)
      } else {
        setError('That doesn\'t look like a valid bot token. It should be like: 123456789:ABCDefGHI...')
      }
    }
    process.stdin.on('data', handler)
    return () => { process.stdin.off('data', handler) }
  }, [onTokenSaved])

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

  return (
    <Pane>
      <Box flexDirection="column">
        <Text bold>📱 Connect Telegram Bot</Text>
        <Text> </Text>
        <Text>To connect rayu-cli to Telegram, you need a bot token:</Text>
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
 * Step 2: Bot token exists — show QR code for linking, auto-close when linked.
 */
function LinkStep({ onDone }: Props): React.ReactNode {
  const token = getBotToken()!
  const [pairToken] = useState(() => randomUUID().slice(0, 8))
  const [qr, setQr] = useState('')
  const [botUsername, setBotUsername] = useState<string | undefined>(undefined)
  const setAppState = useSetAppState()

  useEffect(() => {
    // Persist the bot token to config so useTelegramBridge can always read it
    // (even if the env var isn't available in all contexts).
    saveBotToken(token)

    // Activate the bridge immediately so it starts polling and can receive
    // the /start command from the user's phone. Without this, the bridge
    // never polls and the link is never detected (chicken-and-egg deadlock).
    setAppState(prev => ({ ...prev, telegramBridgeActive: true }))

    setPendingToken(pairToken, TOKEN_TTL_MS)
    void getBotUsername(token).then(async name => {
      setBotUsername(name)
      const deepLink = name ? `https://t.me/${name}?start=${pairToken}` : pairToken
      try {
        setQr(await qrToString(deepLink, { type: 'utf8', errorCorrectionLevel: 'L' }))
      } catch {
        // QR generation failed — token text is still shown
      }
    })
  }, [token, pairToken, setAppState])

  // Poll config to detect when the bot binds this chat — auto-close when linked.
  useEffect(() => {
    const timer = setInterval(() => {
      if (readTelegramConfig().linkedChatId !== undefined) {
        // Linked! Auto-close this dialog — bridge is already active.
        clearInterval(timer)
        onDone()
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [onDone])

  const lines = qr.split('\n').filter(l => l.length > 0)
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
 * Main component: routes between token input and QR link steps.
 * If already linked, just activates the bridge and closes.
 */
function TelegramBotConnect({ onDone }: Props): React.ReactNode {
  const [hasToken, setHasToken] = useState(() => !!getBotToken())
  const setAppState = useSetAppState()

  // If already linked (e.g. from a previous session), just activate and close immediately.
  useEffect(() => {
    if (hasToken && readTelegramConfig().linkedChatId !== undefined) {
      setAppState(prev => ({ ...prev, telegramBridgeActive: true }))
      onDone()
    }
  }, [hasToken, onDone, setAppState])

  if (!hasToken) {
    return <TokenInputStep onTokenSaved={() => setHasToken(true)} />
  }

  return <LinkStep onDone={onDone} />
}

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <TelegramBotConnect onDone={onDone} />
}
