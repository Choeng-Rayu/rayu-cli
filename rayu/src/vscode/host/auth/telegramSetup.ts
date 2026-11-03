/**
 * Telegram connection (`/telegram-bot`) from the editor.
 *
 * ── WHY THIS SPAWNS A CHILD RATHER THAN CALLING THE SERVICES ────────────────────
 *
 * Identical reasoning to `providerSetup.ts`: the hosted pairing calls reach
 * `services/rayuAuth/rayuSession.js` and BYO verification calls Telegram's API,
 * and every one of those modules costs ~19 MB of the engine graph (they reach
 * `utils/log.ts` through `execFileNoThrow`). The host bundle budget is 1.6 MB.
 * The rule is settled: when a needed import blows the budget, the WORK moves into
 * the engine child; the ceiling does not move.
 *
 * The child runs the CLI's own `telegramConfig`, `telegramHostedApi` and
 * `telegramApi` modules, so a link established here is indistinguishable from one
 * established with `/telegram-bot` in the terminal.
 *
 * ── CREDENTIALS ────────────────────────────────────────────────────────────────
 *
 * A BYO bot token travels host → child ONLY, inside the stdin action to a child
 * this host spawned — never in its argv, which every local user can read from the
 * process table. No frame carries one back, so a token cannot reach the webview,
 * the transcript, persisted webview state, or a log line. `describeAction()` exists
 * so progress and error reporting never has to stringify the action itself.
 */
import {
  TELEGRAM_CONNECT_FLAG,
  type TelegramConnectAction,
} from '../../shared/telegramConnectProtocol.js'
import {
  runEngineChild,
  stderrExcerpt,
  type EngineChildResult,
  type EngineLaunch,
} from '../engine/engineLaunch.js'

/**
 * Hosted pairing creation and BYO token verification hit network APIs. Generous,
 * because a slow corporate proxy is common and a premature failure here looks like
 * a broken token or an unreachable backend.
 */
const TELEGRAM_CONNECT_TIMEOUT_MS = 90_000

export interface TelegramSetupOptions {
  /** How to start the engine — see `engine/engineLaunch.ts`. */
  launch: EngineLaunch
  cwd: string
}

export interface TelegramConnectOutcome {
  ok: boolean
  linkedChatId?: number
  linkedBotUsername?: string
  mode?: 'hosted' | 'byo' | null
  botUsername?: string
  /** PNG data-URL of the pairing QR. Only present for a hosted pairing. */
  qr?: string
  /** The t.me deep link the user opens to complete pairing. */
  deepLink?: string
  /** The single-use hosted pairing code. */
  pairingCode?: string
  /** Already user-facing. Never contains a credential. */
  error?: string
}

/** Read the local link state through the child, so the host reads no engine modules. */
export async function telegramConnectStatus(
  options: TelegramSetupOptions,
): Promise<TelegramConnectOutcome> {
  return await runTelegramConnectChild(options, { action: 'status' })
}

/** Create a hosted pairing in the child; the host polls `getHostedLink` afterwards. */
export async function startHostedTelegramPairing(
  options: TelegramSetupOptions,
): Promise<TelegramConnectOutcome> {
  return await runTelegramConnectChild(options, { action: 'start-hosted' })
}

/**
 * Verify a BYO bot token, and on success persist it and create a pending pairing.
 *
 * The token goes into the stdin action — the only place it ever travels. The
 * outcome carries the deep link (`https://t.me/<bot>?start=<pairToken>`) the user
 * opens to finish pairing; it never carries the token.
 */
export async function verifyByoTelegramToken(
  options: TelegramSetupOptions,
  token: string,
): Promise<TelegramConnectOutcome> {
  return await runTelegramConnectChild(options, { action: 'start-byo', token })
}

/** Forget the current chat binding (and the server-side link in hosted mode). */
export async function unlinkTelegram(
  options: TelegramSetupOptions,
): Promise<TelegramConnectOutcome> {
  return await runTelegramConnectChild(options, { action: 'unlink' })
}

type TelegramStatusFrame = Pick<
  TelegramConnectOutcome,
  'linkedChatId' | 'linkedBotUsername' | 'mode' | 'botUsername'
>

async function runTelegramConnectChild(
  options: TelegramSetupOptions,
  action: TelegramConnectAction,
): Promise<TelegramConnectOutcome> {
  let statusFrame: TelegramStatusFrame | undefined
  let qr: string | undefined

  // ── THE ACTION GOES OVER STDIN, NEVER ARGV ───────────────────────────────────
  //
  // `start-byo` carries the user's bot token. A process's argv is readable by
  // EVERY local user (`ps`, `/proc/<pid>/cmdline`) for as long as it runs, and
  // these helpers run for a network round-trip. Stdin is private to the two
  // processes.
  const result = await runEngineChild<TelegramConnectOutcome>(options.launch, {
    flag: TELEGRAM_CONNECT_FLAG,
    cwd: options.cwd,
    stdin: JSON.stringify(action),
    timeoutMs: TELEGRAM_CONNECT_TIMEOUT_MS,
    onFrame: parsed => {
      if (parsed.type === 'rayucode_tgconnect_status') {
        statusFrame = statusFrom(parsed)
        return undefined
      }
      if (parsed.type === 'rayucode_tgconnect_qr' && typeof parsed.image === 'string') {
        qr = parsed.image
        return undefined
      }
      // `rayucode_tgconnect_progress` is intentionally not surfaced yet: the panel shows
      // its own step state, and a second progress channel would contradict it.
      if (parsed.type !== 'rayucode_tgconnect_result') return undefined
      return telegramOutcomeFrom(parsed, statusFrame, qr)
    },
  })
  return result.kind === 'done' ? result.value : telegramFailure(action, result)
}

function statusFrom(parsed: Record<string, unknown>): TelegramStatusFrame {
  return {
    linkedChatId: typeof parsed.linkedChatId === 'number' ? parsed.linkedChatId : undefined,
    linkedBotUsername:
      typeof parsed.linkedBotUsername === 'string' ? parsed.linkedBotUsername : undefined,
    mode: parsed.mode === 'hosted' || parsed.mode === 'byo' ? parsed.mode : null,
    botUsername: typeof parsed.botUsername === 'string' ? parsed.botUsername : undefined,
  }
}

/** The outcome a `rayucode_tgconnect_result` frame reports. */
function telegramOutcomeFrom(
  parsed: Record<string, unknown>,
  statusFrame: TelegramStatusFrame | undefined,
  qr: string | undefined,
): TelegramConnectOutcome {
  if (parsed.ok !== true) {
    return {
      ok: false,
      error: typeof parsed.error === 'string' ? parsed.error : 'unknown error',
    }
  }
  return {
    ok: true,
    linkedChatId: statusFrame?.linkedChatId,
    linkedBotUsername: statusFrame?.linkedBotUsername,
    mode: statusFrame?.mode,
    botUsername:
      typeof parsed.botUsername === 'string' ? parsed.botUsername : statusFrame?.botUsername,
    qr,
    deepLink: typeof parsed.deepLink === 'string' ? parsed.deepLink : undefined,
    pairingCode: typeof parsed.pairingCode === 'string' ? parsed.pairingCode : undefined,
  }
}

/** The user-facing outcome for a helper that ended without a result frame. */
function telegramFailure(
  action: TelegramConnectAction,
  result: Exclude<EngineChildResult<TelegramConnectOutcome>, { kind: 'done' }>,
): TelegramConnectOutcome {
  switch (result.kind) {
    case 'timeout':
      return {
        ok: false,
        error: `${describeAction(action)} timed out after ${Math.round(
          TELEGRAM_CONNECT_TIMEOUT_MS / 1000,
        )}s. The backend or Telegram may be unreachable.`,
      }
    case 'protocol-error':
      return { ok: false, error: `telegram connect channel error: ${result.message}` }
    case 'spawn-error':
      return { ok: false, error: `could not start the telegram connect helper: ${result.message}` }
    case 'exited':
    case 'aborted':
      // Exiting without a result frame means the helper died. The stderr tail is the
      // difference between an actionable error and "it failed".
      return {
        ok: false,
        error:
          `${describeAction(action)} did not complete (helper exited with code ${
            result.kind === 'exited' ? result.code : null
          }).${result.kind === 'exited' ? stderrExcerpt(result.stderrTail) : ''}`,
      }
  }
}

/**
 * A human description of an action, for messages.
 *
 * Exists so no error path is ever tempted to stringify the action object, which
 * would put a bot token into a message.
 */
function describeAction(action: TelegramConnectAction): string {
  switch (action.action) {
    case 'status':
      return 'Loading the Telegram link status'
    case 'start-hosted':
      return 'Creating a hosted Telegram pairing'
    case 'start-byo':
      return 'Verifying the Telegram bot token'
    case 'unlink':
      return 'Disconnecting Telegram'
  }
}
