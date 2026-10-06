/**
 * `/web-bridge` — connect this session to the standalone Rayu Studio, or disconnect it.
 *
 * The CLI counterpart of the studio's remote page: once connected, this session appears
 * in the picker at /remote and can be prompted, interrupted, and have its tool
 * approvals answered from a browser.
 *
 * A COMMAND RATHER THAN A SETTING, ON PURPOSE. Connecting grants a browser tab the
 * ability to run tools on this machine. That is not something to acquire by upgrading
 * the CLI or by a config file someone else wrote — it is a decision made per session,
 * out loud. The connection also dies with the session, so it cannot be left on by
 * accident.
 */

import type { Command, LocalCommandCall } from '../types/command.js'
import {
  getRayuStudioRemoteUrl,
  getValidRayuAccessToken,
} from '../services/rayuAuth/rayuSession.js'
import {
  beginGuestPairing,
  guestPairingStatus,
  stopGuestPairing,
} from '../webBridge/guestPairing.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import { getRayuConfigHomeDir } from '../utils/envUtils.js'
import { resolveHostname, resolveMachineId } from '../webBridge/client/machineId.js'

/**
 * Human-readable rendering of the socket state.
 *
 * `registering` is reported distinctly and deliberately. A socket can be
 * authenticated yet have no session id, in which case the studio cannot list this
 * machine and no prompt can reach it. Calling that "connected" is what produced the
 * confusing case where the CLI claimed success and the studio showed nothing — both
 * were accurate about different things, and the user had no way to tell them apart.
 */
function describeConnection(state: string | undefined): string {
  switch (state) {
    case 'connected':
      return 'connected'
    case 'registering':
      return 'connected, waiting for the server to register this machine'
    case 'connecting':
      return 'connecting…'
    case 'reconnecting':
      return 'reconnecting…'
    case 'error':
      return 'not usable — the server never registered this machine. Check that you are signed in and the Rayu API is reachable'
    default:
      return 'starting…'
  }
}

/** True only when a browser can actually drive this session. */
function isUsable(state: string | undefined): boolean {
  return state === 'connected'
}

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim().toLowerCase()
  const state = context.getAppState()
  const active = state.webBridgeActive === true
  const guest = guestPairingStatus()

  // --- status ---------------------------------------------------------------
  if (arg === 'status') {
    if (!active) {
      if (guest?.status === 'waiting') return { type: 'text', value: `Waiting for Studio approval. Scan or open ${guest.url}` }
      if (guest?.status === 'error') return { type: 'text', value: `Web bridge pairing failed: ${guest.error}` }
      return {
        type: 'text',
        value:
          'Web bridge: disconnected\nUse "/web-bridge" to connect this session to Rayu Studio.',
      }
    }
    return {
      type: 'text',
      value: isUsable(state.webBridgeConnection)
        ? `Web bridge: connected\nOpen ${getRayuStudioRemoteUrl()} to drive this session.`
        : `Web bridge: ${describeConnection(state.webBridgeConnection)}`,
    }
  }

  // --- disconnect -----------------------------------------------------------
  if (arg === 'off' || arg === 'stop' || arg === 'disconnect') {
    if (!active && !guest) {
      return { type: 'text', value: 'Web bridge is not connected.' }
    }
    stopGuestPairing()
    // Lowering the flag is the whole teardown: useWebBridge's effect owns the socket's
    // lifetime and its cleanup stops the client and clears the permission callbacks.
    context.setAppState(s => ({ ...s, webBridgeActive: false }))
    return { type: 'text', value: 'Web bridge disconnected.' }
  }

  if (arg && arg !== 'on' && arg !== 'connect' && arg !== 'pair') {
    return {
      type: 'text',
      value: 'Usage: /web-bridge [status|off|pair]',
    }
  }

  // --- connect --------------------------------------------------------------
  if (active) {
    return {
      type: 'text',
      value: isUsable(state.webBridgeConnection)
        ? `Web bridge is already connected.\nOpen ${getRayuStudioRemoteUrl()} to drive this session.`
        : `Web bridge is ${describeConnection(state.webBridgeConnection)}.\nUse "/web-bridge off" then "/web-bridge" to retry.`,
    }
  }

  if (arg === 'pair' || !(await getValidRayuAccessToken())) {
    try {
      const cwd = getOriginalCwd() ?? process.cwd()
      const pairing = await beginGuestPairing(
        () => context.setAppState(s => ({ ...s, webBridgeActive: true, webBridgeConnection: 'connecting' })),
        () => {},
        {
          machineId: resolveMachineId(getRayuConfigHomeDir()),
          hostname: resolveHostname(),
          cwd,
          pid: process.pid,
          sessionLabel: `rayu CLI — ${cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'session'}`,
        },
      )
      const { toString: qrToString } = await import('qrcode')
      const qr = await qrToString(pairing.url, { type: 'utf8', small: true, errorCorrectionLevel: 'L' })
      return {
        type: 'text',
        value: [
          'Scan this QR code with a device signed into Rayu Studio, then approve this machine:',
          qr,
          pairing.url,
          '',
          'This grants Web Bridge control for this worker session only; it does not sign the worker into Rayu.',
          'Use "/web-bridge status" to check, or "/web-bridge off" to cancel.',
        ].join('\n'),
      }
    } catch (error) {
      return {
        type: 'text',
        value: `Could not start Studio pairing: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  context.setAppState(s => ({
    ...s,
    webBridgeActive: true,
    webBridgeConnection: 'connecting',
  }))

  return {
    type: 'text',
    value: [
      'Connecting this session to Rayu Studio…',
      '',
      `Open ${getRayuStudioRemoteUrl()} and pick this machine to send prompts,`,
      'approve tool calls, and interrupt turns from your browser.',
      '',
      'The connection lasts for this session only. Use "/web-bridge off" to stop it.',
    ].join('\n'),
  }
}

const webBridge = {
  type: 'local',
  name: 'web-bridge',
  description: 'Drive this CLI session from Rayu Studio',
  // Pointless outside an interactive session: the bridge's whole purpose is to relay a
  // live REPL, and a one-shot `--print` run has finished before a browser could attach.
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default webBridge
