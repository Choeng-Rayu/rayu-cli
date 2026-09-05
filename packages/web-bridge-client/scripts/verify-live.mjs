/**
 * Live check of the REAL WebBridgeClient against a running backend.
 *
 * Distinct from diagnose-web-bridge.mjs, which hand-rolls the frames: this drives the
 * shipped client, so it verifies the code the CLI and the extension actually run —
 * including the synchronous `cli_hello` on connect that the ordering bug rejected, and
 * the retry that now covers it.
 *
 * Usage: node scripts/verify-live.mjs
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebBridgeClient } from '../dist/index.js'

const path = join(process.env.RAYU_CONFIG_DIR || join(homedir(), '.rayu'), 'rayu-auth.json')
const stored = JSON.parse(readFileSync(path, 'utf8'))

const states = []
let acked = null

const client = new WebBridgeClient({
  apiBaseUrl: (process.env.RAYU_API_URL || 'http://localhost:4000/api').replace(/\/$/, ''),
  getToken: async () => stored.accessToken,
  hello: {
    machineId: 'liveverify00000000000live',
    hostname: 'live-verify',
    cwd: process.cwd(),
    pid: process.pid,
    sessionLabel: 'live verification',
  },
  handlers: {
    onPrompt: p => console.log(`   onPrompt: ${JSON.stringify(p.text)}`),
    onDecision: d => console.log(`   onDecision: ${JSON.stringify(d)}`),
    onInterrupt: () => console.log('   onInterrupt'),
    onHelloAck: ack => {
      acked = ack.sessionId
    },
    onBridgeError: e => console.log(`   onBridgeError: ${e.message}`),
    onConnectionChange: s => {
      states.push(s)
      console.log(`   state -> ${s}`)
    },
  },
  log: m => console.log(`   ${m}`),
})

console.log('connecting the real client…')
const started = await client.connect()
console.log(`connect() returned ${started}`)

// Long enough to cover one retry cycle, so a first-attempt rejection would still show
// up as an eventual success rather than being mistaken for a clean pass.
await new Promise(r => setTimeout(r, 5000))

console.log('\n=== RESULT ===')
console.log(`state sequence : ${states.join(' -> ')}`)
console.log(`sessionId      : ${acked ?? 'NONE'}`)
console.log(`isRoutable     : ${client.isRoutable}`)

if (client.isRoutable) {
  console.log('\nPASS: the shipped client registered a session and is routable.')
} else {
  console.log('\nFAIL: the client is not routable — the studio will not list it.')
}

client.stop()
process.exit(client.isRoutable ? 0 : 1)
