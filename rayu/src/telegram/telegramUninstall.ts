/**
 * `/uninstall` over Telegram: a TYPED device lifecycle operation.
 *
 * THE OPERATION IS `UNINSTALL_RAYU{deviceId}`. It is not a command string, and
 * nothing in this file constructs, forwards, or evaluates one. That distinction is
 * the whole security model: Telegram may drive RAYU's *named operations*, but it
 * must never become a way to run arbitrary things on a developer's machine. A
 * `/run`, `/shell`, or `/exec` would collapse every control here into "the
 * attacker has a shell", so those deliberately do not exist.
 *
 * FOUR INDEPENDENT GATES stand between a chat message and a wiped machine:
 *
 *  1. A LOCAL OPT-IN — `allowRemoteUninstall`, default off, settable only at the
 *     terminal (the command that sets it is on the Telegram blocked list, so the
 *     chat cannot grant itself the capability).
 *  2. EXPLICIT DEVICE TARGETING — the user must name which machine. A developer
 *     with a laptop and a desktop must not be able to wipe the wrong one by
 *     sending a bare command.
 *  3. A CONFIRMATION TOKEN — single-use, short-lived, and BOUND to the Telegram
 *     user, the chat, and the device. Bound rather than merely random so a token
 *     observed in one context cannot be replayed in another.
 *  4. A CONCURRENCY LOCK — the device is marked `uninstalling` before anything is
 *     destroyed, and further commands are refused while a teardown runs.
 *
 * The token discipline mirrors the pairing token in telegramConfig.ts: crypto
 * randomness, constant-time comparison, a bounded attempt count, and burn-on-
 * exhaustion. That code exists because the bot is publicly reachable; this
 * operation is strictly more dangerous, so it inherits the same rules.
 */

import { randomBytes, timingSafeEqual } from 'crypto'
import { escapeHtml, sendMessage, sendMessageWithInlineKeyboard } from './telegramApi.js'
import { isRemoteUninstallAllowed } from './telegramConfig.js'
import { getDeviceIdentity } from '../utils/deviceIdentity.js'
import { listDevices, type RemoteDevice } from '../services/rayuAuth/rayuDevices.js'
import { planUninstall } from '../cli/uninstall/uninstallService.js'
import { startUninstall } from '../cli/uninstall/uninstallOrchestrator.js'
import {
  describeUninstallRun,
  isUninstallInProgress,
  readUninstallRun,
} from '../cli/uninstall/uninstallState.js'
import { logForDebugging } from '../utils/debug.js'

/**
 * Confirmation lifetime. Short on purpose: long enough to read the card and type
 * six characters, short enough that a token left on screen is not a standing
 * authorisation to wipe the machine.
 */
const CONFIRMATION_TTL_MS = 90_000

/**
 * Wrong codes tolerated before the pending confirmation is destroyed.
 *
 * Same reasoning as MAX_PAIRING_ATTEMPTS: Telegram's flood limits already make
 * online guessing slow, but a hard cap removes the possibility rather than
 * merely slowing it. On exhaustion the confirmation is burnt and the user must
 * start over — a real user retries once, a guesser is out.
 */
const MAX_CONFIRMATION_ATTEMPTS = 3

interface PendingConfirmation {
  requestId: string
  code: string
  /** Telegram user the card was shown to. */
  telegramUserId: number
  /** Chat the card was shown in. */
  chatId: number
  /** Device this confirmation authorises — and ONLY this device. */
  deviceId: string
  deviceName: string
  expiresAt: number
  attempts: number
}

/**
 * At most one pending confirmation, in memory only.
 *
 * NOT PERSISTED, deliberately: a CLI restart must invalidate it. Persisting would
 * mean a token created before a crash still authorises destruction afterwards,
 * which is the opposite of what a 90-second confirmation is for.
 */
let pending: PendingConfirmation | null = null

/** Six characters, unambiguous alphabet — no 0/O or 1/I to mistype. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateConfirmationCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  }
  return code
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function isExpired(confirmation: PendingConfirmation): boolean {
  return confirmation.expiresAt < Date.now()
}

/** Test helper — drops any pending confirmation. */
export function _resetUninstallConfirmation(): void {
  pending = null
}

// ---- Device targeting ------------------------------------------------------

/**
 * Resolve which device `/uninstall <target>` means.
 *
 * A bare `/uninstall` NEVER resolves to a device. With one machine that might
 * look like harmless convenience, but the same habit on a two-machine account
 * wipes whichever one happens to be listed first — so the command always
 * requires the user to say which.
 */
type TargetResolution =
  | { kind: 'this-device'; deviceId: string; deviceName: string }
  | { kind: 'remote-device'; device: RemoteDevice }
  | { kind: 'needs-target'; devices: RemoteDevice[] }
  | { kind: 'unknown-target'; target: string; devices: RemoteDevice[] }

async function resolveTarget(rawTarget: string): Promise<TargetResolution> {
  const identity = getDeviceIdentity()
  const devices = await listDevices()
  const target = rawTarget.trim()

  if (!target) return { kind: 'needs-target', devices }

  // Match on device id first (exact, unambiguous), then on name
  // case-insensitively for the common case of typing what the list showed.
  const byId = devices.find(d => d.deviceId === target)
  const byName =
    byId ??
    devices.find(d => d.deviceName.toLowerCase() === target.toLowerCase())

  if (byName) {
    return byName.deviceId === identity.deviceId
      ? {
          kind: 'this-device',
          deviceId: identity.deviceId,
          deviceName: byName.deviceName,
        }
      : { kind: 'remote-device', device: byName }
  }

  // Signed out (no device list) but the user named THIS machine.
  if (
    devices.length === 0 &&
    (target === identity.deviceId ||
      target.toLowerCase() === identity.deviceName.toLowerCase())
  ) {
    return {
      kind: 'this-device',
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
    }
  }

  return { kind: 'unknown-target', target, devices }
}

function formatDeviceList(devices: readonly RemoteDevice[]): string {
  const identity = getDeviceIdentity()
  if (devices.length === 0) {
    return [
      `• <b>${escapeHtml(identity.deviceName)}</b> (this machine)`,
      `  <code>/uninstall ${escapeHtml(identity.deviceName)}</code>`,
    ].join('\n')
  }
  return devices
    .map(device => {
      const here = device.deviceId === identity.deviceId ? ' (this machine)' : ''
      const state = device.online ? '🟢' : '⚪'
      return [
        `${state} <b>${escapeHtml(device.deviceName)}</b>${here} — ${escapeHtml(device.platform)}/${escapeHtml(device.arch)}`,
        `  <code>/uninstall ${escapeHtml(device.deviceName)}</code>`,
      ].join('\n')
    })
    .join('\n')
}

// ---- The command -----------------------------------------------------------

/**
 * Handle `/uninstall [device]` and `/uninstall confirm <code>`.
 *
 * Returns true when the message was consumed, so the bridge does not also treat
 * it as a prompt.
 */
export async function handleUninstallCommand(
  token: string,
  chatId: number,
  telegramUserId: number,
  arg: string,
): Promise<void> {
  // GATE 1: the local opt-in. Checked first so a machine that has not enabled
  // this reveals nothing about its devices.
  if (!isRemoteUninstallAllowed()) {
    await sendMessage(
      token,
      chatId,
      [
        '🔒 <b>Remote uninstall is disabled on this machine.</b>',
        '',
        'It is off by default because it cannot be undone: with it enabled, ' +
          'access to this Telegram account is enough to remove RAYU and its saved ' +
          'credentials.',
        '',
        'To enable it, run this <b>at the computer itself</b>:',
        '<code>/telegram-remote-uninstall on</code>',
      ].join('\n'),
      'HTML',
    )
    return
  }

  // GATE 4 (first half): refuse anything while a teardown is running.
  const run = readUninstallRun()
  if (isUninstallInProgress() && run) {
    await sendMessage(
      token,
      chatId,
      `⏳ <b>An uninstall is already running.</b>\n\n<pre>${escapeHtml(describeUninstallRun(run))}</pre>`,
      'HTML',
    )
    return
  }

  const [first, second] = arg.trim().split(/\s+/, 2)

  if (first?.toLowerCase() === 'confirm') {
    await handleConfirmation(token, chatId, telegramUserId, second ?? '')
    return
  }

  await beginConfirmation(token, chatId, telegramUserId, arg)
}

/** Show the confirmation card for a specific device. */
async function beginConfirmation(
  token: string,
  chatId: number,
  telegramUserId: number,
  rawTarget: string,
): Promise<void> {
  const resolution = await resolveTarget(rawTarget)

  // GATE 2: explicit device targeting.
  if (resolution.kind === 'needs-target') {
    await sendMessage(
      token,
      chatId,
      [
        '🖥 <b>Which device should RAYU be removed from?</b>',
        '',
        formatDeviceList(resolution.devices),
        '',
        '<i>You must name the device — this cannot be undone, so RAYU will not guess.</i>',
      ].join('\n'),
      'HTML',
    )
    return
  }

  if (resolution.kind === 'unknown-target') {
    await sendMessage(
      token,
      chatId,
      [
        `⚠️ No device named <b>${escapeHtml(resolution.target)}</b>.`,
        '',
        formatDeviceList(resolution.devices),
      ].join('\n'),
      'HTML',
    )
    return
  }

  // A device other than this one cannot be torn down from here: the operation
  // runs locally, and this process can only remove its own machine. The target
  // device's own CLI will pick the request up when the Mini App / backend
  // fan-out lands; until then, say so plainly rather than silently doing nothing.
  if (resolution.kind === 'remote-device') {
    await sendMessage(
      token,
      chatId,
      [
        `⚠️ <b>${escapeHtml(resolution.device.deviceName)}</b> is a different machine.`,
        '',
        'Remote uninstall currently runs only on the machine whose rayu-cli is ' +
          'connected to this chat. Open rayu-cli on that machine, connect it, and ' +
          'run the command there.',
      ].join('\n'),
      'HTML',
    )
    return
  }

  const plan = await planUninstall({ keepData: false })
  if (plan.install.method === 'development') {
    await sendMessage(
      token,
      chatId,
      `⚠️ ${escapeHtml(plan.install.reason)}.`,
    )
    return
  }

  // GATE 3: issue a bound, single-use confirmation.
  const requestId = randomBytes(9).toString('base64url')
  const code = generateConfirmationCode()
  pending = {
    requestId,
    code,
    telegramUserId,
    chatId,
    deviceId: resolution.deviceId,
    deviceName: resolution.deviceName,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    attempts: 0,
  }

  const artifactLines = plan.present.map(a => `• ${escapeHtml(a.label)}`)
  const notRemovable = plan.canRemovePackage
    ? ''
    : `\n\n<i>Note: this is a ${escapeHtml(plan.install.method)} install, so RAYU cannot remove the package itself` +
      (plan.install.manualCommand
        ? ` — you will need to run <code>${escapeHtml(plan.install.manualCommand)}</code>.</i>`
        : '.</i>')

  await sendMessageWithInlineKeyboard(
    token,
    chatId,
    [
      `⚠️ <b>Remove RAYU from ${escapeHtml(resolution.deviceName)}?</b>`,
      '',
      'This will:',
      ...artifactLines,
      '',
      'It will <b>not</b> touch your projects, source code, or git repositories.',
      '',
      '<b>This cannot be undone.</b>',
      notRemovable,
      '',
      `Send this within 90 seconds to confirm:`,
      `<code>/uninstall confirm ${code}</code>`,
    ].join('\n'),
    // A single Cancel button. There is deliberately NO "Confirm" button: a
    // one-tap wipe is far too easy to hit by accident, and a typed code proves
    // the user read the card.
    [[{ text: '❌ Cancel', callback_data: CB_UNINSTALL_CANCEL }]],
    'HTML',
  )
}

/** callback_data for the cancel button. */
export const CB_UNINSTALL_CANCEL = 'unin:cancel'

/** Handle a tap on the uninstall Cancel button. Returns true if it was ours. */
export async function handleUninstallCallback(
  token: string,
  chatId: number,
  data: string,
): Promise<boolean> {
  if (data !== CB_UNINSTALL_CANCEL) return false
  pending = null
  await sendMessage(token, chatId, '✅ Uninstall cancelled — nothing was changed.')
  return true
}

/** Verify a typed confirmation code and start the teardown. */
async function handleConfirmation(
  token: string,
  chatId: number,
  telegramUserId: number,
  suppliedCode: string,
): Promise<void> {
  const confirmation = pending
  if (!confirmation || isExpired(confirmation)) {
    pending = null
    await sendMessage(
      token,
      chatId,
      '⌛ That confirmation has expired. Send /uninstall again if you still want to.',
    )
    return
  }

  // Binding checks. A code is only valid in the exact context it was issued for,
  // so one seen elsewhere — a forwarded message, a shared group, a second
  // account — cannot be replayed here.
  if (
    confirmation.chatId !== chatId ||
    confirmation.telegramUserId !== telegramUserId
  ) {
    logForDebugging(
      '[uninstall] confirmation rejected: chat or user does not match the issued context',
    )
    await sendMessage(
      token,
      chatId,
      '❌ That confirmation was not issued for this chat.',
    )
    return
  }

  if (!constantTimeEquals(confirmation.code, suppliedCode.trim().toUpperCase())) {
    confirmation.attempts += 1
    if (confirmation.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
      pending = null
      await sendMessage(
        token,
        chatId,
        '❌ Too many incorrect codes — the request has been cancelled. Send /uninstall to start over.',
      )
      return
    }
    await sendMessage(
      token,
      chatId,
      `❌ Incorrect code. ${MAX_CONFIRMATION_ATTEMPTS - confirmation.attempts} attempt(s) left.`,
    )
    return
  }

  // Single use: burn it before doing anything, so a duplicate delivery of the
  // same message cannot start a second teardown.
  pending = null

  await sendMessage(
    token,
    chatId,
    `🧹 Removing RAYU from <b>${escapeHtml(confirmation.deviceName)}</b>…`,
    'HTML',
  )

  const result = await startUninstall({
    requestId: confirmation.requestId,
    origin: 'telegram',
    keepData: false,
  })

  if (result.kind === 'refused') {
    await sendMessage(
      token,
      chatId,
      `⚠️ Uninstall could not start: ${escapeHtml(result.reason)}`,
      'HTML',
    )
    return
  }

  if (result.kind === 'already-running') {
    await sendMessage(
      token,
      chatId,
      `⏳ An uninstall was already running.\n\n<pre>${escapeHtml(describeUninstallRun(result.run))}</pre>`,
      'HTML',
    )
    return
  }

  await sendMessage(
    token,
    chatId,
    [
      '🔌 <b>Uninstall started.</b>',
      '',
      'Sessions have been asked to close and this chat has been unlinked. ' +
        'A background helper is removing the remaining files.',
      '',
      '<i>This is the last message you will receive from this machine.</i>',
    ].join('\n'),
    'HTML',
  )
}
