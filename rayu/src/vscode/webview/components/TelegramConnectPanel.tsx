/**
 * In-panel Telegram connection — the editor's `/telegram-bot`.
 *
 * ── THE BOT TOKEN IS WRITE-ONLY ────────────────────────────────────────────────
 *
 * A BYO (@BotFather) token lives in local component state, is sent once in
 * `onStartByo`, and is never read back from host state. `TelegramConnectView` has no
 * field that could hold one, so a token cannot end up in persisted webview state, a
 * diagnostic, or the transcript. The input is `type="password"` and `autoComplete="off"`
 * so the editor's own webview persistence and the browser credential manager have
 * nothing to capture either.
 *
 * ── VALIDATE THEN LINK, AS TWO STEPS ───────────────────────────────────────────
 *
 * Verifying the token with Telegram happens before it is saved, so a revoked or
 * mistyped token fails here with an actionable error rather than later as a silent hang
 * on the waiting screen. The hosted path creates the pairing the same way and then
 * waits for the link to be completed in Telegram.
 */
import { useState } from 'react'

import type { TelegramConnectView } from '../../shared/webviewProtocol.js'
import { CloseIcon } from './Icons.js'

export interface TelegramConnectPanelProps {
  connect: TelegramConnectView
  /**
   * Shown as a card inside Settings → Integrations rather than as a closable panel: it
   * renders whatever `connect.open` says, and has no title or close button of its own.
   */
  embedded?: boolean
  onClose?: () => void
  onStartHosted: () => void
  onStartByo: (token: string) => void
  onUnlink: () => void
}

export function TelegramConnectPanel({
  connect,
  embedded = false,
  onClose,
  onStartHosted,
  onStartByo,
  onUnlink,
}: TelegramConnectPanelProps): JSX.Element | null {
  const [token, setToken] = useState('')
  const [mode, setMode] = useState<'hosted' | 'byo' | null>(null)

  if (!connect.open && !embedded) return null

  const linked = connect.linkedChatId !== null

  function submitByo(): void {
    const trimmed = token.trim()
    if (!trimmed) return
    onStartByo(trimmed)
    // Write-only: the value has been handed to the host and is dropped from view state.
    setToken('')
  }

  return (
    <div className={`rc-setup${embedded ? ' rc-setup-embedded' : ''}`} role="region" aria-label="Connect Telegram">
      {embedded ? null : (
        <div className="rc-setup-head">
          <h2 className="rc-setup-title">Connect Telegram</h2>
          <button type="button" className="rc-icon-button" title="Close" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      )}

      {connect.error ? (
        <p className="rc-setup-error" role="alert">
          {connect.error}
        </p>
      ) : null}

      {connect.busy ? (
        <p className="rc-setup-hint" role="status">
          {connect.busyMessage ?? 'Working…'}
        </p>
      ) : null}

      {linked ? (
        <div className="rc-setup-form">
          <p className="rc-setup-chosen">Telegram is connected</p>
          <p className="rc-setup-note">
            {connect.linkedBotUsername ? (
              <>
                Linked through <strong>@{connect.linkedBotUsername}</strong>.
              </>
            ) : (
              'This Telegram bot is linked.'
            )}{' '}
            Chat ID <code>{connect.linkedChatId}</code>.
          </p>
          <div className="rc-setup-actions">
            <button type="button" className="rc-button" disabled={connect.busy} onClick={onUnlink}>
              {connect.busy ? (connect.busyMessage ?? 'Working…') : 'Disconnect Telegram'}
            </button>
          </div>
        </div>
      ) : mode === null ? (
        <div className="rc-setup-form">
          <p className="rc-setup-note">Choose how to connect this editor to Telegram.</p>
          <ul className="rc-dropdown-list" role="listbox">
            <li role="none">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="rc-dropdown-item"
                onClick={() => setMode('hosted')}
              >
                <span className="rc-dropdown-label">Rayu shared bot — recommended</span>
                <span className="rc-dropdown-detail">
                  Sign in with Rayu and scan a QR. No bot to create.
                </span>
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="rc-dropdown-item"
                onClick={() => setMode('byo')}
              >
                <span className="rc-dropdown-label">Your own bot token</span>
                <span className="rc-dropdown-detail">
                  Create a bot with @BotFather and paste its token.
                </span>
              </button>
            </li>
          </ul>
        </div>
      ) : mode === 'hosted' ? (
        <div className="rc-setup-form">
          <button type="button" className="rc-setup-back" onClick={() => setMode(null)}>
            ← Choose another way
          </button>

          <p className="rc-setup-chosen">Rayu shared bot</p>

          {connect.qr ? (
            <>
              <img
                src={connect.qr}
                alt="QR code for the Telegram pairing link"
                width={180}
                height={180}
                style={{ alignSelf: 'center', borderRadius: 4 }}
              />
              {connect.pairingCode ? (
                <p className="rc-setup-note">
                  Scan the QR, or open the bot and send{' '}
                  <code>/start {connect.pairingCode}</code>.
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="rc-setup-note">
                Pair this editor with the shared Rayu Telegram bot. Requires a signed-in Rayu
                account.
              </p>
              <div className="rc-setup-actions">
                <button
                  type="button"
                  className="rc-button"
                  disabled={connect.busy}
                  onClick={onStartHosted}
                >
                  {connect.busy ? (connect.busyMessage ?? 'Working…') : 'Generate QR'}
                </button>
              </div>
            </>
          )}

          {connect.waitingForLink && connect.deepLink ? (
            <WaitingForLink deepLink={connect.deepLink} />
          ) : null}
        </div>
      ) : (
        <div className="rc-setup-form">
          <button type="button" className="rc-setup-back" onClick={() => setMode(null)}>
            ← Choose another way
          </button>

          <p className="rc-setup-chosen">Connect your own Telegram bot</p>

          <p className="rc-setup-note">Steps:</p>
          <ol className="rc-setup-note">
            <li>
              Open Telegram and search for <strong>@BotFather</strong>.
            </li>
            <li>
              Send <code>/newbot</code> and follow the prompts.
            </li>
            <li>
              Copy the bot token (looks like <code>123456789:ABCDef…</code>).
            </li>
            <li>Paste it below and connect.</li>
          </ol>

          <label className="rc-setup-label">
            Bot token
            <input
              className="rc-setup-input"
              type="password"
              /* Nothing should offer to remember this. */
              autoComplete="off"
              spellCheck={false}
              value={token}
              placeholder="Paste your bot token"
              onChange={e => setToken(e.target.value)}
            />
            <span className="rc-setup-hint">
              Checked with Telegram before it is saved. It is never sent back to this panel or
              stored in view state.
            </span>
          </label>

          <div className="rc-setup-actions">
            <button
              type="button"
              className="rc-button"
              disabled={connect.busy || token.trim().length === 0}
              onClick={submitByo}
            >
              {connect.busy ? (connect.busyMessage ?? 'Working…') : 'Verify and connect'}
            </button>
          </div>

          {connect.waitingForLink && connect.deepLink ? (
            <WaitingForLink deepLink={connect.deepLink} />
          ) : null}
        </div>
      )}
    </div>
  )
}

/**
 * The pairing deep link and the "waiting" hint.
 *
 * Shared by both paths rather than duplicated: hosted and BYO both produce a
 * `https://t.me/<bot>?start=<code>` link, and the user has to open it in Telegram either
 * way. Hosted also renders the QR and `/start <code>` line above it.
 */
function WaitingForLink({ deepLink }: { deepLink: string }): JSX.Element {
  return (
    <>
      <p className="rc-setup-note">
        Open <code>{deepLink}</code> to finish linking.
      </p>
      <p className="rc-setup-hint">
        Waiting for you to link in Telegram… (the code is valid for 10 minutes)
      </p>
    </>
  )
}
