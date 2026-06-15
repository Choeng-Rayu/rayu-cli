'use client'

import React, { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'

type ToolKind = 'bash' | 'read' | 'write' | 'edit' | 'glob' | 'grep'

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

const TOOL_COLOR: Record<ToolKind, string> = {
  bash: '#e5c07b',
  read: '#61afef',
  write: '#00FF88',
  edit: '#ff5f57',
  glob: '#c678dd',
  grep: '#56b6c2',
}

function rid() { return Math.random().toString(36).slice(2, 9) }

const BOOT: Msg[] = [
  { id: 'b1', role: 'user', text: 'rayu "fix the auth bug"' },
  {
    id: 'b2', role: 'assistant', text: 'Done. Fixed token expiry check on line 47.',
    toolCalls: [
      { kind: 'read', label: 'Read(src/auth.ts)', body: ['Reading src/auth.ts…', '142 lines read'], done: true },
      { kind: 'edit', label: 'Edit(src/auth.ts)', body: ['- if (now > expires) {', '+ if (now < expires) {'], done: true },
      { kind: 'bash', label: 'Bash(bun test)', body: ['$ bun test', '✓ 12 tests passed in 0.41s'], done: true },
    ],
  },
]

function pickResponse(input: string): { text: string; toolCalls?: ToolCall[] } {
  const s = input.toLowerCase()
  if (s === '/help' || s === 'help')
    return { text: '/fix  /build  /test  /list\nOr describe your task naturally.' }
  if (s === '/model' || s === 'model')
    return { text: 'Model: claude-sonnet-4-6\nRun /connect to switch providers.' }
  if (s === '/connect')
    return { text: 'Run  $ rayu /connect  then paste your API key.' }
  if (s === '/clear') return { text: '__CLEAR__' }
  if (s.includes('fix') || s.includes('bug') || s.includes('error'))
    return {
      text: 'Fixed. Token expiry check was inverted on line 47.',
      toolCalls: [
        { kind: 'read', label: 'Read(src/auth.ts)', body: ['142 lines read'], done: true },
        { kind: 'edit', label: 'Edit(src/auth.ts)', body: ['- if (now > expires) {', '+ if (now < expires) {'], done: true },
        { kind: 'bash', label: 'Bash(bun test auth)', body: ['$ bun test src/auth.test.ts', '✓ 12 tests passed in 0.41 s'], done: true },
      ],
    }
  if (s.includes('build'))
    return {
      text: 'Build complete.',
      toolCalls: [{ kind: 'bash', label: 'Bash(bun run build)', body: ['$ bun run build', '▸ rayu.js  4.2 MB', '✓ Build successful'], done: true }],
    }
  if (s.includes('test'))
    return {
      text: 'Ran full suite.',
      toolCalls: [{ kind: 'bash', label: 'Bash(bun test)', body: ['$ bun test', '✓ 47 tests passed in 2.3 s'], done: true }],
    }
  if (s.includes('list') || s.includes('files'))
    return {
      text: 'Here are the TypeScript files:',
      toolCalls: [{ kind: 'glob', label: 'Glob(**/*.ts)', body: ['src/main.tsx', 'src/utils/auth.ts', 'src/utils/config.ts', '…38 more'], done: true }],
    }
  if (s.includes('hello') || s.includes('hi'))
    return { text: "Hey! I'm Rayu. Tell me what to build, fix, or ship." }
  return { text: "On it. Use /help to see what I can do." }
}

function ToolBlock({ tc }: { tc: ToolCall }) {
  const color = TOOL_COLOR[tc.kind]
  return (
    <div style={{ margin: '2px 0 2px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color, fontSize: '0.78rem' }}>●</span>
        <span style={{ color, fontFamily: 'monospace', fontSize: '0.82rem' }}>{tc.label}</span>
        {!tc.done && <span style={{ color: '#4a5568', fontSize: '0.72rem', animation: 'htPulse 0.8s infinite' }}>running…</span>}
      </div>
      {tc.body.length > 0 && (
        <div style={{ marginLeft: 16, borderLeft: '2px solid rgba(255,255,255,0.06)', paddingLeft: 10, marginTop: 2 }}>
          {tc.body.map((line, i) => (
            <div key={i} style={{
              fontFamily: 'monospace', fontSize: '0.78rem', whiteSpace: 'pre',
              color: line.startsWith('+') ? '#00FF88' : line.startsWith('-') ? '#ff5f57' : line.startsWith('$') ? '#e5c07b' : line.startsWith('✓') ? '#00FF88' : '#4a5568',
            }}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function HeroTerminal() {
  const [messages, setMessages] = useState<Msg[]>(BOOT)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [userActive, setUserActive] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const autoRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const userActiveRef = useRef(false)
  const busyRef = useRef(false)

  useEffect(() => { userActiveRef.current = userActive }, [userActive])
  useEffect(() => { busyRef.current = busy }, [busy])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const DEMO_INPUTS = ['fix the auth bug', 'build the project', 'run the tests', 'list files']
  const demoIdxRef = useRef(0)

  const runDemoLoop = useCallback(async () => {
    const sleep = (ms: number) => new Promise<void>(r => { autoRef.current = setTimeout(r, ms) })

    while (!userActiveRef.current) {
      await sleep(2200)
      if (userActiveRef.current || busyRef.current) return

      const prompt = DEMO_INPUTS[demoIdxRef.current % DEMO_INPUTS.length]
      demoIdxRef.current++

      // type char by char
      for (let i = 1; i <= prompt.length; i++) {
        if (userActiveRef.current) return
        setInput(prompt.slice(0, i))
        await sleep(65)
      }

      await sleep(500)
      if (userActiveRef.current || busyRef.current) { setInput(''); return }

      // submit
      setInput('')
      setHistory(h => [prompt, ...h.slice(0, 49)])
      setBusy(true)
      setMessages(prev => [...prev, { id: rid(), role: 'user', text: prompt }])
      await sleep(250)

      const { text: reply, toolCalls } = pickResponse(prompt)
      const aid = rid()
      setMessages(prev => [...prev, { id: aid, role: 'assistant', text: '', toolCalls: toolCalls?.map(tc => ({ ...tc, done: false })), streaming: true }])

      if (toolCalls) {
        for (let t = 0; t < toolCalls.length; t++) {
          if (userActiveRef.current) break
          await sleep(300 + toolCalls[t].body.length * 60)
          setMessages(prev => prev.map(m => {
            if (m.id !== aid) return m
            const tcs = [...(m.toolCalls ?? [])]
            tcs[t] = { ...tcs[t], done: true }
            return { ...m, toolCalls: tcs }
          }))
        }
        await sleep(150)
      }

      // stream text
      for (let i = 1; i <= reply.length; i++) {
        if (userActiveRef.current) break
        await sleep(10)
        setMessages(prev => prev.map(m => m.id === aid ? { ...m, text: reply.slice(0, i) } : m))
      }
      setMessages(prev => prev.map(m => m.id === aid ? { ...m, text: reply, streaming: false } : m))
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    runDemoLoop()
    return () => { if (autoRef.current) clearTimeout(autoRef.current) }
  }, [])

  const streamText = useCallback(async (id: string, full: string) => {
    for (let i = 1; i <= full.length; i++) {
      await new Promise<void>(r => setTimeout(r, 10))
      setMessages(prev => prev.map(m => m.id === id ? { ...m, text: full.slice(0, i) } : m))
    }
  }, [])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    if (autoRef.current) clearTimeout(autoRef.current)
    setInput(''); setHistIdx(-1)
    setHistory(h => [text, ...h.slice(0, 49)])
    setBusy(true)
    setMessages(prev => [...prev, { id: rid(), role: 'user', text }])
    await new Promise(r => setTimeout(r, 250))
    const { text: reply, toolCalls } = pickResponse(text)
    if (reply === '__CLEAR__') {
      setMessages(BOOT); setBusy(false); return
    }
    const aid = rid()
    setMessages(prev => [...prev, { id: aid, role: 'assistant', text: '', toolCalls: toolCalls?.map(tc => ({ ...tc, done: false })), streaming: true }])
    if (toolCalls) {
      for (let t = 0; t < toolCalls.length; t++) {
        await new Promise(r => setTimeout(r, 300 + toolCalls[t].body.length * 60))
        setMessages(prev => prev.map(m => {
          if (m.id !== aid) return m
          const tcs = [...(m.toolCalls ?? [])]
          tcs[t] = { ...tcs[t], done: true }
          return { ...m, toolCalls: tcs }
        }))
      }
      await new Promise(r => setTimeout(r, 150))
    }
    await streamText(aid, reply)
    setMessages(prev => prev.map(m => m.id === aid ? { ...m, streaming: false } : m))
    setBusy(false)
  }, [input, busy, streamText])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    setUserActive(true)
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); return }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHistIdx(i => { const n = Math.min(i + 1, history.length - 1); if (history[n]) setInput(history[n]); return n })
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHistIdx(i => { const n = Math.max(i - 1, -1); setInput(n === -1 ? '' : history[n] ?? ''); return n })
    }
  }, [handleSend, history])

  return (
    <>
      <style>{`
        @keyframes htBlink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes htPulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .ht-scroll::-webkit-scrollbar{width:4px}
        .ht-scroll::-webkit-scrollbar-thumb{background:#1a1f2e;border-radius:2px}
        .ht-input:focus{outline:none}
        .ht-input::placeholder{color:#4a5568}
      `}</style>
      <div
        style={{
          background: 'var(--bg3)',
          border: '1px solid var(--border-bright)',
          borderRadius: 12,
          boxShadow: '0 20px 40px rgba(0,0,0,0.6), 0 0 30px rgba(0,255,136,0.03)',
          overflow: 'hidden',
          fontFamily: "'DM Mono', monospace",
          fontSize: '0.88rem',
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          flexDirection: 'column',
          height: 340,
        }}
        onClick={() => { setUserActive(true); inputRef.current?.focus() }}
      >
        {/* Title bar */}
        <div style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 7 }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e' }} />
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#27c93f' }} />
          </div>
          <span style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>rayu — ~/my-project</span>
          <span style={{ color: 'var(--green)', fontSize: '0.72rem', border: '1px solid rgba(0,255,136,0.2)', padding: '2px 8px', borderRadius: 4, background: 'rgba(0,255,136,0.05)' }}>
            claude-sonnet-4-6
          </span>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="ht-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {messages.map(msg => msg.role === 'user' ? (
            <div key={msg.id} style={{ display: 'flex', gap: 8, margin: '6px 0 2px' }}>
              <span style={{ color: 'var(--green)', fontWeight: 700 }}>&gt;</span>
              <span style={{ color: '#fff', whiteSpace: 'pre-wrap' }}>{msg.text}</span>
            </div>
          ) : (
            <div key={msg.id} style={{ margin: '2px 0 6px' }}>
              {msg.toolCalls?.map((tc, i) => <ToolBlock key={i} tc={tc} />)}
              {(msg.text || msg.streaming) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <span style={{ color: 'var(--green)', fontSize: '0.82rem' }}>✦</span>
                  <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
                    {msg.text}
                    {msg.streaming && <span style={{ display: 'inline-block', width: '0.45em', height: '0.9em', background: 'var(--text)', marginLeft: 1, verticalAlign: 'text-bottom', animation: 'htBlink 1s step-end infinite' }} />}
                  </span>
                </div>
              )}
            </div>
          ))}
          {busy && messages[messages.length - 1]?.role === 'user' && (
            <span style={{ color: '#4a5568', fontSize: '0.8rem', animation: 'htPulse 0.8s infinite', marginLeft: 16 }}>thinking…</span>
          )}
        </div>

        {/* Input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 10px', borderTop: '1px solid var(--border)', background: 'var(--bg3)', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <span style={{ color: busy ? '#4a5568' : 'var(--green)', fontWeight: 700 }}>&gt;</span>
          <input
            ref={inputRef}
            className="ht-input"
            disabled={busy}
            value={input}
            onChange={e => { setUserActive(true); setInput(e.target.value) }}
            onKeyDown={handleKeyDown}
            onFocus={() => setUserActive(true)}
            placeholder={busy ? '' : userActive ? 'Try: fix the bug, /help, /model…' : ''}
            style={{ flex: 1, background: 'transparent', border: 'none', color: '#fff', fontFamily: 'inherit', fontSize: '0.88rem', caretColor: userActive ? 'var(--green)' : 'transparent', padding: 0 }}
          />
          {!userActive && !busy && !input && (
            <span style={{ color: 'var(--green)', animation: 'htBlink 1s step-end infinite', marginLeft: -4 }}>▒</span>
          )}
          {busy && <span style={{ color: '#4a5568', fontSize: '0.75rem', animation: 'htPulse 0.8s infinite' }}>working…</span>}
        </div>
      </div>
    </>
  )
}
