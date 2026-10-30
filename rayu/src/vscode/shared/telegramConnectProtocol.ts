/**
 * The telegram-connect child protocol.
 *
 * Shared by the two ends of the in-panel Telegram connection:
 *
 *   src/entrypoints/vscodeHost.ts                 the child, which does the work
 *   src/vscode/host/auth/telegramSetup.ts         the extension host, which spawns it
 *
 * ── WHY THIS RUNS IN THE ENGINE CHILD AT ALL ───────────────────────────────────
 *
 * Telegram connection is not just a config write. Creating a hosted pairing talks
 * to rayu-backend with the signed-in session token (`getHostedBotInfo`,
 * `createHostedPairing` both reach `services/rayuAuth/rayuSession.js`), and BYO
 * verification calls Telegram's own API (`getBotUsername`). Those modules pull the
 * engine graph — measured at ~19 MB for their provider-setup neighbours — because
 * they reach `utils/log.ts`. Importing any of them into `extension.js` would blow
 * the host bundle budget many times over. The rule established for login and
 * provider setup applies unchanged: if a needed import blows the budget, move the
 * WORK into the engine child rather than raising the ceiling.
 *
 * The cheap read-only pieces (`readTelegramConfig`, `getTelegramMode`) are also
 * done in the child so the host never needs a second code path — the child is the
 * single implementation of the flow, identical to what `/telegram-bot` runs in the
 * terminal.
 *
 * ── NOTHING HERE MAY IMPORT ANYTHING ───────────────────────────────────────────
 *
 * Same reason as `connectProtocol.ts`: `vscodeHost.ts` has top-level side effects
 * and its graph is the whole engine, so the contract cannot live beside the code
 * that reads it.
 */

/**
 * Switches the engine bundle from "run the engine" to "perform one telegram-connect
 * action and exit".
 *
 * A flag rather than a separate entrypoint, so `build:vscode` keeps emitting one
 * engine bundle. The action itself is JSON written to the child's STDIN — never an
 * argument, because `start-byo` carries a bot token and argv is readable by every
 * local user through the process table.
 */
export const TELEGRAM_CONNECT_FLAG = '--rayucode-telegram-connect'

/** Actions the host asks the child to perform. Exactly one per child process. */
export type TelegramConnectAction =
  /**
   * Report the current link state from the LOCAL config only.
   *
   * Never touches the network: it answers from `readTelegramConfig()`, so a panel
   * refresh cannot block on Telegram or the backend, and it never resolves the bot's
   * live @username with `getMe` (the recorded `linkedBotUsername` is used instead).
   * It emits exactly one status frame. No credentials are read.
   */
  | { action: 'status' }
  /**
   * Start pairing against the shared Rayu-hosted bot.
   *
   * Requires a signed-in Rayu session (`hasRayuSession`): the backend owns the
   * shared bot's token, so the child must hold the session JWT to create a pairing.
   * On success the child sets the telegram mode to 'hosted', renders the QR for
   * the pairing deep link, and reports the deep link + code. Hosted-mode polling
   * (`getHostedLink`) deliberately stays in the HOST: it is a cheap authenticated
   * HTTP call and the panel needs to drive it interactively.
   */
  | { action: 'start-hosted' }
  /**
   * Save and validate a BYO (@BotFather) bot token.
   *
   * The token arrives on stdin inside this action. It is normalised and shape-checked
   * (`normalizeBotToken`/`isValidBotToken`), then verified against Telegram
   * (`getBotUsername`). On success the child saves the token, sets mode 'byo', and
   * creates a one-time pending pairing token (`setPendingToken`, 10-minute TTL) so
   * the caller can hand the user a `https://t.me/<bot>?start=<pairToken>` deep link.
   * There is no QR for BYO: the deep link is rendered by the caller.
   */
  | { action: 'start-byo'; token: string }
  /**
   * Forget the current chat binding. Hosted mode also deletes the server-side link
   * (`deleteHostedLink`). Mode and a BYO token survive, matching the CLI's unlink.
   */
  | { action: 'unlink' }

/**
 * Frames the telegram-connect child writes to stdout, one JSON object per line.
 *
 * The `rayucode_tgconnect_` prefix keeps them distinguishable from engine protocol
 * frames, connect frames and login frames on a shared stream.
 *
 * ── NO FRAME EVER CARRIES A CREDENTIAL ─────────────────────────────────────────
 *
 * A bot token travels host → child only, and only inside the stdin action to a
 * child the host spawned itself. Nothing sends one back, so a token cannot reach
 * the webview, the transcript, persisted webview state, or a log line.
 */
export type TelegramConnectFrame =
  /**
   * Snapshot of the local link state, emitted before the result of a `status`
   * action (and available to any action that wants to refresh the panel).
   */
  | {
      type: 'rayucode_tgconnect_status'
      linkedChatId?: number
      linkedBotUsername?: string
      mode: 'hosted' | 'byo' | null
      /** The bot the CLI would talk to right now, when known. */
      botUsername?: string
    }
  /**
   * PNG data-URL of the QR code for the hosted pairing deep link, rendered in the
   * child with the `qrcode` package (the same approach the pairing-qr child uses).
   * Only emitted for `start-hosted` — BYO has no QR.
   */
  | { type: 'rayucode_tgconnect_qr'; image: string }
  /** Progress narration for a step that can take seconds. Never contains a token. */
  | { type: 'rayucode_tgconnect_progress'; message: string }
  | {
      type: 'rayucode_tgconnect_result'
      ok: true
      /** `start-hosted`: the t.me deep link the QR encodes. */
      deepLink?: string
      /** `start-hosted`: the single-use pairing code. */
      pairingCode?: string
      /** The bot's @username, when the action discovered it. */
      botUsername?: string
    }
  | { type: 'rayucode_tgconnect_result'; ok: false; error: string }
