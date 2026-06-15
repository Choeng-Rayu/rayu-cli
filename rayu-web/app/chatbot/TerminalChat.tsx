'use client'

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from 'react'

/* ─── types ─────────────────────────────────────────────── */

type ToolKind = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep' | 'agent'

interface ToolCall {
  kind: ToolKind
  label: string
  body: string[]
  done: boolean
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls?: ToolCall[]
  streaming?: boolean
}

/* ─── colour palette (mirrors RAYU CLI) ─────────────────── */
const C = {
  bg: '#030507',
  panel: '#0a0c10',
  border: '#1a1f2e',
  text: '#e6e9ef',
  muted: '#6b7280',
  accent: '#00FF88',
  green: '#00FF88',
  yellow: '#e5c07b',
  red: '#ff5f57',
  cyan: '#56b6c2',
  purple: '#c678dd',
  blue: '#61afef',
}

const TOOL_COLOR: Record<ToolKind, string> = {
  bash: C.yellow,
  read: C.blue,
  write: C.green,
  edit: C.red,
  glob: C.purple,
  grep: C.cyan,
  agent: '#6d7cff',
}

/* ─── mock AI responses ──────────────────────────────────── */

function randomId() {
  return Math.random().toString(36).slice(2, 9)
}

const DEMO_PROMPTS: Record<string, () => Msg['toolCalls']> = {
  default: () => undefined,
  fix: () => [
    {
      kind: 'read',
      label: 'Read(src/auth.ts)',
      body: ['Reading src/auth.ts…', '142 lines read'],
      done: true,
    },
    {
      kind: 'edit',
      label: 'Edit(src/auth.ts)',
      body: ['- if (now > expires) {', '+ if (now < expires) {'],
      done: true,
    },
    {
      kind: 'bash',
      label: 'Bash(bun test auth)',
      body: ['$ bun test src/auth.test.ts', '✓ 12 tests passed in 0.41 s'],
      done: true,
    },
  ],
  build: () => [
    {
      kind: 'bash',
      label: 'Bash(bun run build)',
      body: [
        '$ bun run build',
        'Bundling…',
        '▸ dist/rayu.js  4.2 MB in 1.2 s',
        '✓ Build successful',
      ],
      done: true,
    },
  ],
  test: () => [
    {
      kind: 'bash',
      label: 'Bash(bun test)',
      body: ['$ bun test', '✓ 47 tests passed in 2.3 s', '✗ 2 tests failed'],
      done: true,
    },
    {
      kind: 'read',
      label: 'Read(test/utils.test.ts)',
      body: ['Reading test/utils.test.ts…', '88 lines read'],
      done: true,
    },
  ],
  list: () => [
    {
      kind: 'glob',
      label: 'Glob(**/*.ts)',
      body: [
        'src/main.tsx',
        'src/utils/auth.ts',
        'src/utils/config.ts',
        '…and 38 more',
      ],
      done: true,
    },
  ],
}

function pickResponse(input: string): {
  text: string
  toolCalls?: ToolCall[]
} {
  const lower = input.toLowerCase()
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) {
    return {
      text: `I'll look at the relevant file and patch the bug.\n\nFound it: the token-expiry check was inverted on line 47. Fixed and all tests pass.`,
      toolCalls: DEMO_PROMPTS.fix(),
    }
  }
  if (lower.includes('build')) {
    return {
      text: 'Running the production build now.',
      toolCalls: DEMO_PROMPTS.build(),
    }
  }
  if (lower.includes('test')) {
    return {
      text: `I ran the full suite. Two tests are failing in \`test/utils.test.ts\`. Let me check them.`,
      toolCalls: DEMO_PROMPTS.test(),
    }
  }
  if (lower.includes('list') || lower.includes('files')) {
    return {
      text: 'Here are the TypeScript files in the project:',
      toolCalls: DEMO_PROMPTS.list(),
    }
  }
  if (lower.includes('hello') || lower.includes('hi')) {
    return {
      text: "Hey! I'm Rayu, your AI coding agent. Tell me what you'd like to work on.",
    }
  }
  if (lower === '/help' || lower.includes('help')) {
    return {
      text: `Available commands:\n  /help     — show this message\n  /model    — switch AI model\n  /connect  — add a provider API key\n  /clear    — clear session\n\nOr just describe your task:\n  • Fix bugs or errors\n  • Build or run tests\n  • List or search files\n  • Write new features`,
    }
  }
  if (lower === '/model') {
    return {
      text: 'Current model: claude-sonnet-4-6\n\nAvailable:\n  claude-sonnet-4-6  (default)\n  claude-opus-4-6\n  claude-haiku-4-5\n  gpt-4o\n  gemini-1.5-pro\n\nRun /connect to add a provider.',
    }
  }
  if (lower === '/connect') {
    return {
      text: 'To connect a provider, run:\n\n  $ rayu /connect\n\nThen paste your API key when prompted.\nSupported: Anthropic, OpenAI, Gemini, Groq, Together, Bedrock.',
    }
  }
  if (lower === '/clear') {
    return { text: '__CLEAR__' }
  }
  return {
    text: `Got it. I'll take a look and work on that for you.\n\nUse \`/help\` to see what I can do, or just describe your task naturally.`,
  }
}

/* ─── sub-components ─────────────────────────────────────── */

function ToolBlock({ tc }: { tc: ToolCall }) {
  const color = TOOL_COLOR[tc.kind]
  return (
    <div style={{ margin: '0.4rem 0 0.4rem 1.2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          marginBottom: '0.25rem',
        }}
      >
        <span style={{ color, fontSize: '0.8rem' }}>⏺</span>
        <span
          style={{
            color,
            fontSize: '0.82rem',
            fontFamily: 'monospace',
          }}
        >
          {tc.label}
        </span>
        {!tc.done && (
          <span
            style={{
              color: C.muted,
              fontSize: '0.75rem',
              animation: 'pulse 1s infinite',
            }}
          >
            running…
          </span>
        )}
      </div>
      {tc.body.length > 0 && (
        <div
          style={{
            marginLeft: '1rem',
            borderLeft: `2px solid ${C.border}`,
            paddingLeft: '0.75rem',
          }}
        >
          {tc.body.map((line, i) => (
            <div
              key={i}
              style={{
                fontFamily: 'monospace',
                fontSize: '0.8rem',
                color: line.startsWith('+')
                  ? C.green
                  : line.startsWith('-')
                    ? C.red
                    : line.startsWith('$')
                      ? C.yellow
                      : line.startsWith('✓')
                        ? C.green
                        : line.startsWith('✗')
                          ? C.red
                          : C.muted,
                whiteSpace: 'pre',
              }}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UserBubble({ msg }: { msg: Msg }) {
  return (
    <div style={{ display: 'flex', gap: '0.6rem', margin: '1rem 0 0.25rem' }}>
      <span
        style={{
          color: C.green,
          fontFamily: 'monospace',
          fontWeight: 700,
          fontSize: '1rem',
          lineHeight: 1.6,
          userSelect: 'none',
        }}
      >
        &gt;
      </span>
      <span
        style={{
          color: C.text,
          fontFamily: 'monospace',
          fontSize: '0.92rem',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {msg.text}
      </span>
    </div>
  )
}

function AssistantBubble({ msg }: { msg: Msg }) {
  return (
    <div style={{ margin: '0.5rem 0 1rem' }}>
      {/* tool calls first */}
      {msg.toolCalls?.map((tc, i) => <ToolBlock key={i} tc={tc} />)}
      {/* text */}
      {(msg.text || msg.streaming) && (
        <div style={{ display: 'flex', gap: '0.6rem', margin: '0.3rem 0 0' }}>
          <span
            style={{
              color: C.green,
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              lineHeight: 1.6,
              userSelect: 'none',
              marginTop: '0.05rem',
            }}
          >
            ✦
          </span>
          <span
            style={{
              color: C.text,
              fontFamily: 'monospace',
              fontSize: '0.88rem',
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {msg.text}
            {msg.streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: '0.5em',
                  height: '1em',
                  background: C.text,
                  marginLeft: '1px',
                  verticalAlign: 'text-bottom',
                  animation: 'blink 1s step-end infinite',
                }}
              />
            )}
          </span>
        </div>
      )}
    </div>
  )
}

/* ─── main terminal component ────────────────────────────── */

export default function TerminalChat() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: "Welcome to Rayu ✦\n\nI'm your AI coding agent. Tell me what to build, fix, or ship.\nType /help for available commands.",
    },
  ])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [tokenCount, setTokenCount] = useState(0)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  /* auto-scroll to bottom */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /* focus input on click anywhere */
  const focusInput = useCallback(() => inputRef.current?.focus(), [])

  /* streaming typewriter helper */
  const streamText = useCallback(
    async (msgId: string, fullText: string, delay = 12) => {
      for (let i = 1; i <= fullText.length; i++) {
        await new Promise<void>((r) => setTimeout(r, delay))
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, text: fullText.slice(0, i) } : m,
          ),
        )
      }
    },
    [],
  )

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return

    setInput('')
    setHistIdx(-1)
    setHistory((h) => [text, ...h.slice(0, 49)])
    setBusy(true)

    /* add user message */
    const userId = randomId()
    setMessages((prev) => [...prev, { id: userId, role: 'user', text }])

    /* short pause before response */
    await new Promise((r) => setTimeout(r, 280))

    /* pick mock response */
    const { text: reply, toolCalls } = pickResponse(text)

    /* handle /clear */
    if (reply === '__CLEAR__') {
      setMessages([{
        id: randomId(),
        role: 'assistant',
        text: "Session cleared. What would you like to work on?",
      }])
      setBusy(false)
      return
    }

    const assistantId = randomId()

    /* add assistant message skeleton */
    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: 'assistant',
        text: '',
        toolCalls: toolCalls?.map((tc) => ({ ...tc, done: false })),
        streaming: true,
      },
    ])

    /* animate tool calls appearing */
    if (toolCalls && toolCalls.length > 0) {
      for (let t = 0; t < toolCalls.length; t++) {
        await new Promise((r) => setTimeout(r, 350))
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const tcs = [...(m.toolCalls ?? [])]
            tcs[t] = { ...tcs[t], done: false }
            return { ...m, toolCalls: tcs }
          }),
        )
        await new Promise((r) =>
          setTimeout(r, 300 + toolCalls[t].body.length * 80),
        )
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m
            const tcs = [...(m.toolCalls ?? [])]
            tcs[t] = { ...tcs[t], done: true }
            return { ...m, toolCalls: tcs }
          }),
        )
      }
      await new Promise((r) => setTimeout(r, 200))
    }

    /* stream reply text */
    await streamText(assistantId, reply)

    /* mark done */
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, streaming: false } : m,
      ),
    )

    setTokenCount((c) => c + Math.floor(text.length / 4) + Math.floor(reply.length / 4))
    setBusy(false)
  }, [input, busy, streamText])

  /* keyboard handling */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHistIdx((i) => {
          const next = Math.min(i + 1, history.length - 1)
          if (history[next] !== undefined) setInput(history[next])
          return next
        })
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHistIdx((i) => {
          const next = Math.max(i - 1, -1)
          setInput(next === -1 ? '' : history[next] ?? '')
          return next
        })
      }
    },
    [handleSend, history],
  )

  /* cost estimate from token count */
  const costStr = tokenCount > 0
    ? `$${((tokenCount / 1000) * 0.003).toFixed(4)}`
    : '$0.0000'

  return (
    <>
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .terminal-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .terminal-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .terminal-scroll::-webkit-scrollbar-thumb {
          background: #232838;
          border-radius: 3px;
        }
        .terminal-scroll::-webkit-scrollbar-thumb:hover {
          background: #3a4060;
        }
        .tool-input:focus {
          outline: none;
        }
      `}</style>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 56px)',
          background: C.bg,
          fontFamily: '"SF Mono", "Fira Code", "Fira Mono", "Cascadia Code", Consolas, monospace',
        }}
        onClick={focusInput}
      >
        {/* ── window chrome ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.5rem 1rem',
            background: C.panel,
            borderBottom: `1px solid ${C.border}`,
            userSelect: 'none',
          }}
        >
          {/* traffic lights */}
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e', display: 'inline-block' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#28ca42', display: 'inline-block' }} />

          <div style={{ flex: 1, textAlign: 'center' }}>
            <span style={{ color: C.muted, fontSize: '0.78rem' }}>
              rayu — ~/project
            </span>
          </div>

          <span
            style={{
              fontSize: '0.73rem',
              color: C.accent,
              background: 'rgba(0,255,136,0.08)',
              border: `1px solid rgba(0,255,136,0.2)`,
              borderRadius: 4,
              padding: '0.1rem 0.45rem',
            }}
          >
            claude-sonnet-4-6
          </span>
        </div>

        {/* ── messages area ── */}
        <div
          ref={containerRef}
          className="terminal-scroll"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.75rem 1.5rem',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {messages.map((msg) =>
            msg.role === 'user' ? (
              <UserBubble key={msg.id} msg={msg} />
            ) : (
              <AssistantBubble key={msg.id} msg={msg} />
            ),
          )}

          {/* spinner when processing but no assistant msg yet */}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center',
                margin: '0.4rem 0 0.4rem 0',
                color: C.muted,
                fontSize: '0.82rem',
              }}
            >
              <span style={{ animation: 'pulse 0.8s infinite' }}>⏺</span>
              <span>thinking…</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── status bar ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            padding: '0.3rem 1.5rem',
            background: C.panel,
            borderTop: `1px solid ${C.border}`,
            fontSize: '0.72rem',
            color: C.muted,
            userSelect: 'none',
          }}
        >
          <span style={{ color: C.green }}>✦</span>
          <span>claude-sonnet-4-6</span>
          <span style={{ color: C.border }}>│</span>
          <span>tokens: {tokenCount.toLocaleString()}</span>
          <span style={{ color: C.border }}>│</span>
          <span>cost: {costStr}</span>
          <span style={{ flex: 1 }} />
          <span>↑↓ history</span>
          <span style={{ color: C.border }}>│</span>
          <span>Enter to send</span>
        </div>

        {/* ── prompt input ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.6rem',
            padding: '0.6rem 1.5rem 0.75rem',
            background: C.bg,
            borderTop: `1px solid ${C.border}`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            style={{
              color: busy ? C.muted : C.green,
              fontWeight: 700,
              fontSize: '1rem',
              userSelect: 'none',
              transition: 'color 0.2s',
            }}
          >
            &gt;
          </span>
          <input
            ref={inputRef}
            className="tool-input"
            autoFocus
            disabled={busy}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={busy ? '' : 'Message Rayu… (/help /model /connect /clear)'}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              color: busy ? C.muted : C.text,
              fontFamily: 'inherit',
              fontSize: '0.92rem',
              caretColor: C.accent,
              padding: 0,
            }}
          />
          {busy && (
            <span
              style={{
                color: C.muted,
                fontSize: '0.78rem',
                animation: 'pulse 0.8s infinite',
              }}
            >
              working…
            </span>
          )}
        </div>
      </div>
    </>
  )
}
