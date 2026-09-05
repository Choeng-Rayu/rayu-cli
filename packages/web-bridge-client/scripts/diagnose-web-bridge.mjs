/**
 * Web Bridge end-to-end diagnostic.
 *
 * Connects to BOTH namespaces with the token the rayu CLI has stored, and prints what
 * the backend actually does. This exists because "the CLI says connected but the studio
 * shows nothing" has several possible causes that look identical from either end:
 *
 *   - the CLI socket authenticated but `cli_hello` was rejected  -> no session row
 *   - the CLI registered fine but the browser is a DIFFERENT user -> row invisible
 *   - the browser never connected at all                          -> nothing to show
 *
 * Running both halves against one token distinguishes them: if the browser namespace
 * sees the session this script just registered, the CLI and backend are correct and the
 * fault is in the browser's own auth.
 *
 * Usage: node scripts/diagnose-web-bridge.mjs
 * Never prints a token.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { io } from 'socket.io-client'

const API = (process.env.RAYU_API_URL || 'http://localhost:4000/api').replace(/\/$/, '')
const ORIGIN = new URL(API).origin
const WS_PATH = '/api/rayu-ws'
const CLI_NS = '/cli-bridge'
const BROWSER_NS = '/web-bridge'

function loadToken() {
  const path = join(process.env.RAYU_CONFIG_DIR || join(homedir(), '.rayu'), 'rayu-auth.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw.accessToken) throw new Error(`no accessToken in ${path}`)
  const secondsLeft = Math.round((raw.expiresAt - Date.now()) / 1000)
  console.log(`token: user=${raw.user?.email ?? raw.user?.id ?? '?'} expires in ${secondsLeft}s`)
  if (secondsLeft <= 0) {
    console.log('  !! ACCESS TOKEN IS EXPIRED — refresh it by running the CLI once')
  }
  return raw.accessToken
}

function connect(namespace, token, label) {
  return new Promise(resolve => {
    const socket = io(`${ORIGIN}${namespace}`, {
      path: WS_PATH,
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 8000,
    })

    const events = []
    const done = outcome => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.disconnect()
      resolve({ outcome, events })
    }

    const timer = setTimeout(() => done('timeout'), 9000)

    socket.on('connect', () => {
      console.log(`[${label}] connected (transport up + authenticated)`)
      events.push('connect')
    })
    socket.on('connect_error', e => {
      console.log(`[${label}] connect_error: ${e.message}`)
      done('connect_error')
    })
    socket.on('disconnect', reason => {
      console.log(`[${label}] disconnected: ${reason}`)
      // An immediate server-side close right after connect means the handshake was
      // rejected — the CLI gateway disconnects unauthenticated peers with no error frame.
      if (!events.includes('handshake_ok')) done(`disconnected:${reason}`)
    })
    socket.onAny((event, payload) => {
      events.push(event)
      const brief = JSON.stringify(payload ?? null)
      console.log(`[${label}] <- ${event} ${brief.length > 300 ? brief.slice(0, 300) + '…' : brief}`)
      if (event === 'hello_ack' || event === 'session_list') {
        events.push('handshake_ok')
        // Give the backend a beat to push anything that follows.
        setTimeout(() => done('ok'), 1200)
      }
    })

    if (namespace === CLI_NS) {
      socket.on('connect', () => {
        const hello = {
          machineId: 'diagnostic0000000000diag',
          hostname: 'diagnostic-probe',
          cwd: process.cwd(),
          pid: process.pid,
          sessionLabel: 'diagnostic probe',
        }
        console.log(`[${label}] -> cli_hello machineId=${hello.machineId}`)
        socket.emit('cli_hello', hello)
      })
    }
  })
}

const token = loadToken()
console.log(`backend: ${ORIGIN}${WS_PATH}\n`)

console.log('--- 1. CLI namespace (what rayu-cli does) ---')
const cli = await connect(CLI_NS, token, 'cli')
console.log(`result: ${cli.outcome}\n`)

console.log('--- 2. BROWSER namespace (what the studio does) ---')
const browser = await connect(BROWSER_NS, token, 'browser')
console.log(`result: ${browser.outcome}\n`)

console.log('=== VERDICT ===')
const cliOk = cli.events.includes('hello_ack')
const browserOk = browser.events.includes('session_list')
console.log(`CLI    registered a session : ${cliOk ? 'YES' : 'NO'}`)
console.log(`Browser received session_list: ${browserOk ? 'YES' : 'NO'}`)
if (cliOk && browserOk) {
  console.log('\nBoth halves work with THIS token. If the studio shows nothing, the')
  console.log('browser is not presenting this token — check localStorage["rayu_session"].')
} else if (cliOk && !browserOk) {
  console.log('\nThe CLI half works; the browser namespace did not deliver a list.')
} else {
  console.log('\nThe CLI half failed — see the cli_hello / disconnect output above.')
}
process.exit(0)
