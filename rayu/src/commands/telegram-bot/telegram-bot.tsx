import { toString as qrToString } from 'qrcode'
import { randomUUID } from 'crypto'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Pane } from '../../components/design-system/Pane.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getBotToken, readTelegramConfig, setPendingToken } from '../../telegram/telegramConfig.js'
import { getBotUsername } from '../../telegram/telegramApi.js'

const TOKEN_TTL_MS = 10 * 60 * 1000

interface Props {
  onDone: () => void
}

function TelegramBotLink({ onDone }: Props): React.ReactNode {
  const token = getBotToken()
  const [pairToken] = useState(() => randomUUID().slice(0, 8))
  const [qr, setQr] = useState('')
  const [botUsername, setBotUsername] = useState<string | undefined>(undefined)
  const [linkedUsername, setLinkedUsername] = useState<string | undefined>(undefined)

  useKeybinding('confirm:no', onDone, { context: 'Confirmation' })

  useEffect(() => {
    if (!token) return
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
  }, [token, pairToken])

  // Poll config to detect when the bot binds this chat.
  useEffect(() => {
    if (!token) return
    const timer = setInterval(() => {
      const linked = readTelegramConfig().linkedUsername
      if (readTelegramConfig().linkedChatId !== undefined) {
        setLinkedUsername(linked ?? 'your account')
      }
    }, 1500)
    return () => clearInterval(timer)
  }, [token])

  if (!token) {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text bold>Telegram bot not configured</Text>
          <Text> </Text>
          <Text dimColor>1. Create a bot with @BotFather and copy its token.</Text>
          <Text dimColor>2. Set it: export TELEGRAM_BOT_TOKEN=&lt;token&gt;</Text>
          <Text dimColor>3. Restart and run /telegram-bot again.</Text>
        </Box>
      </Pane>
    )
  }

  if (linkedUsername) {
    return (
      <Pane>
        <Box flexDirection="column">
          <Text color="success">✅ Linked as @{linkedUsername}</Text>
          <Text dimColor>Messages in your Telegram chat now drive this CLI. Press esc to close.</Text>
        </Box>
      </Pane>
    )
  }

  const lines = qr.split('\n').filter(l => l.length > 0)
  return (
    <Pane>
      <Box flexDirection="column" autoFocus>
        {lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
        <Text> </Text>
        <Text>Scan the QR{botUsername ? ` to open @${botUsername}` : ''}, or send this to the bot:</Text>
        <Text bold>  /link {pairToken}</Text>
        <Text> </Text>
        <Text dimColor>Waiting for link… (token valid 10 min, esc to close)</Text>
      </Box>
    </Pane>
  )
}

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <TelegramBotLink onDone={onDone} />
}
