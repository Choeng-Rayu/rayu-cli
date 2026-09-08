/**
 * The panel.
 *
 * ── THE `ready` HANDSHAKE IS NOT OPTIONAL ──────────────────────────────────────
 *
 * `postMessage` sent to a webview before its `message` listener is attached is
 * dropped silently. So the host must not push state on its own schedule: this
 * component announces `ready` after mount, and the host answers with `init`. That
 * also makes panel re-creation — which VS Code does whenever it disposes the view —
 * an ordinary path rather than a special case, and it is how a sign-in performed in a
 * terminal reaches this UI.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import type {
  AttachmentView,
  ContextUsageView,
  SessionSummaryView,
  HostToWebviewMessage,
  WebviewState,
  WebviewToHostMessage,
} from '../shared/webviewProtocol.js'
import { chatReducer, initialChatState, type ChatState } from './state/reducer.js'
import { Composer } from './components/Composer.js'
import { ProviderSetupPanel } from './components/ProviderSetupPanel.js'
import { AttachmentControl } from './components/AttachmentControl.js'
import { SessionHistory } from './components/SessionHistory.js'
import { PermissionCard } from './components/PermissionCard.js'
import { SparkleIcon } from './components/SparkleIcon.js'
import { TranscriptEntryView, NoticeEntry } from './components/TranscriptEntryView.js'
import { WelcomeScreen } from './components/WelcomeScreen.js'

/**
 * The bridge VS Code injects into every webview.
 *
 * Declared locally rather than pulled from `@types/vscode`: that package types the
 * EXTENSION HOST API, which does not exist in here. `acquireVsCodeApi` is a global
 * the webview runtime provides, and it may be called only once per page.
 */
declare function acquireVsCodeApi(): {
  postMessage: (message: WebviewToHostMessage) => void
  getState: () => unknown
  setState: (state: unknown) => void
}

const vscodeApi = acquireVsCodeApi()

function send(message: WebviewToHostMessage): void {
  vscodeApi.postMessage(message)
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  /** Text a prompt chip put in the composer but the user has not sent. */
  const [draft, setDraft] = useState<string | null>(null)

  useEffect(() => {
    function onMessage(event: MessageEvent<HostToWebviewMessage>): void {
      const message = event.data
      switch (message.type) {
        case 'init':
        case 'addMessage':
        case 'appendPartial':
        case 'completeMessage':
        case 'turnState':
        case 'removeEntry':
        case 'setModelInfo':
        case 'setModelCatalogue':
        case 'setAttachment':
        case 'setProviderSetup':
        case 'setInferenceSettings':
        case 'setPermissionMode':
        case 'showPermissionRequest':
        case 'dismissPermissionRequest':
        case 'showError':
        case 'removeEntry':
        case 'setCommands':
        case 'fileSearchResults':
        case 'setContextUsage':
        case 'setMcpServers':
        case 'setSessions':
          // The action union is the message union by construction, so the reducer
          // is the single place that decides what each one means.
          dispatch(message)
          return
        default:
          // Host and webview built from different sources. The webview devtools
          // console is the only diagnostic available in here.
          console.error('[rayucode] unrecognised message from host', message)
      }
    }

    window.addEventListener('message', onMessage)
    // Announce only AFTER the listener is attached, or the reply races us.
    send({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const session = state.session
  const signedOut = session === null || session.status === 'signed-out'

  const submit = useCallback((text: string) => {
    setDraft(null)
    send({ type: 'submitPrompt', text })
  }, [])

  return (
    <div className="rc-shell">
      <Header
        state={session}
        contextUsage={state.contextUsage}
        sessions={state.sessions}
        attachment={state.attachment}
        onListAttachable={() => send({ type: 'listAttachable' })}
        onAttach={pid => send({ type: 'attachToSession', pid })}
        onDetach={() => send({ type: 'detachFromSession' })}
        hasActiveTranscript={state.entries.length > 0}
        onListSessions={() => send({ type: 'listSessions' })}
        onResumeSession={id => send({ type: 'resumeSession', id })}
      />

      {/* Above the transcript: it is a modal-ish task the user opened deliberately,
          and it must not be scrolled away from mid-entry. */}
      <ProviderSetupPanel
        setup={state.providerSetup}
        onClose={() => send({ type: 'providerSetupOpen', open: false })}
        onValidate={(providerId, apiKey, baseURL) =>
          send({ type: 'providerSetupValidate', providerId, apiKey, baseURL })
        }
        onSave={(providerId, apiKey, baseURL, model) =>
          send({ type: 'providerSetupSave', providerId, apiKey, baseURL, model })
        }
      />

      <Transcript state={state} onPick={setDraft} signedOut={signedOut} />

      {/* Pinned between the transcript and the composer: the engine is blocked, so
          this must be visible without scrolling, while the transcript it describes
          stays readable. */}
      {state.pendingPermissions.map(request => (
        <PermissionCard
          key={request.requestId}
          request={request}
          onDecide={decision =>
            send({ type: 'permissionResponse', requestId: request.requestId, decision })
          }
        />
      ))}

      {signedOut ? null : (
        <Composer
          key={draft ?? ''}
          initialValue={draft ?? ''}
          disabled={false}
          turnRunning={state.turnRunning}
          modelInfo={state.modelInfo}
          modelCatalogue={state.modelCatalogue}
          inference={state.inference}
          permissionMode={state.permissionMode}
          commands={state.commands}
          workspaceFiles={state.workspaceFiles}
          onSubmit={submit}
          onInterrupt={() => send({ type: 'interrupt' })}
          onSelectModel={value => send({ type: 'selectModelValue', value })}
          onRefreshModels={() => send({ type: 'refreshModelCatalogue' })}
          onSetEffort={level => send({ type: 'setEffort', level })}
          onSetThinking={enabled => send({ type: 'setThinking', enabled })}
          onCyclePermissionMode={() => send({ type: 'cyclePermissionMode' })}
          onOpenProviderSetup={() => send({ type: 'openProviderSetup' })}
          onFindFiles={query => send({ type: 'findFiles', query })}
        />
      )}
    </div>
  )
}

/**
 * Context-window pressure in the header.
 *
 * Shows a bar as well as the number because "how close am I to compaction" is a
 * magnitude question, and a bar answers it without being read. The tone changes only at
 * thresholds where the user would actually do something differently (start a new session,
 * or compact deliberately rather than be compacted mid-thought).
 *
 * A stale reading keeps the last known value with a `~` and says so in the tooltip,
 * rather than showing 0% or disappearing. Disappearing would read as "plenty of room".
 */
function ContextIndicator({ usage }: { usage: ContextUsageView }): JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(usage.percentage)))
  const tone = pct >= 90 ? ' rc-ctx-critical' : pct >= 75 ? ' rc-ctx-warn' : ''
  const tokens =
    usage.totalTokens !== undefined && usage.maxTokens !== undefined
      ? ` (${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens)`
      : ''

  return (
    <span
      className={`rc-header-context${tone}`}
      title={
        usage.stale
          ? `Context usage was ${pct}%${tokens} at the last successful reading. The most recent refresh failed, so this may be out of date.`
          : `Context usage: ${pct}%${tokens}${
              pct >= 90 ? ' — close to compaction.' : ''
            }`
      }
    >
      <span className="rc-ctx-bar" role="presentation">
        <span className="rc-ctx-fill" style={{ width: `${pct}%` }} />
      </span>
      {usage.stale ? '~' : ''}
      {pct}% ctx
    </span>
  )
}

function Header({
  state,
  contextUsage,
  sessions,
  hasActiveTranscript,
  onListSessions,
  onResumeSession,
  attachment,
  onListAttachable,
  onAttach,
  onDetach,
}: {
  state: WebviewState | null
  contextUsage: ContextUsageView | null
  sessions: SessionSummaryView[] | undefined
  hasActiveTranscript: boolean
  onListSessions: () => void
  onResumeSession: (id: string) => void
  attachment: AttachmentView
  onListAttachable: () => void
  onAttach: (pid: number) => void
  onDetach: () => void
}): JSX.Element {
  const who = state?.identity?.displayName ?? state?.identity?.email ?? null

  return (
    <header className="rc-header">
      <span className="rc-header-title">Rayucode</span>
      <span className="rc-header-meta">
        {contextUsage ? <ContextIndicator usage={contextUsage} /> : null}
        {/* Hidden while signed out: there is nothing to resume into, and the picker
            would offer an action that cannot complete. */}
        {state && state.status !== 'signed-out' ? (
          <AttachmentControl
            attachment={attachment}
            onList={onListAttachable}
            onAttach={onAttach}
            onDetach={onDetach}
          />
        ) : null}
        {state && state.status !== 'signed-out' ? (
          <SessionHistory
            sessions={sessions}
            hasActiveTranscript={hasActiveTranscript}
            workspaceFolder={state.workspaceFolder ?? ''}
            onOpen={onListSessions}
            onResume={onResumeSession}
          />
        ) : null}
        {who ? <span className="rc-header-user">{who}</span> : null}
        {state ? <span className="rc-header-version">v{state.version}</span> : null}
      </span>
    </header>
  )
}

/**
 * The scrolling conversation.
 *
 * Auto-scroll follows the newest entry ONLY when the user is already near the bottom.
 * Scrolling them back down while they are reading earlier output is one of the most
 * irritating things a streaming transcript can do.
 */
function Transcript({
  state,
  onPick,
  signedOut,
}: {
  state: ChatState
  onPick: (text: string) => void
  signedOut: boolean
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // 48px of slack: an exact comparison unpins on sub-pixel scroll positions.
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  useEffect(() => {
    if (!pinned.current) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.entries, state.notices])

  const session = state.session

  return (
    <main
      ref={scroller}
      onScroll={onScroll}
      className="rc-transcript"
      role="log"
      aria-live="polite"
      aria-label="Conversation"
    >
      {session === null ? (
        <p className="rc-muted">Connecting…</p>
      ) : session.status === 'signed-out' ? (
        <SignInView state={session} />
      ) : state.entries.length === 0 ? (
        <WelcomeScreen onPick={onPick} disabled={signedOut} />
      ) : (
        state.entries.map(entry => (
          <TranscriptEntryView
            key={entry.id}
            entry={entry}
            onKeep={path => send({ type: 'reviewKeep', path })}
            onUndo={path => send({ type: 'reviewUndo', path })}
            onDiff={path => send({ type: 'openReviewDiff', path })}
            onOpen={path => send({ type: 'openFile', path })}
          />
        ))
      )}

      {state.notices.map((notice, index) => (
        <NoticeEntry key={`notice-${index}`} text={notice} severity="error" />
      ))}
    </main>
  )
}

/**
 * The forced sign-in surface.
 *
 * Shown whenever the shared login gate returns a message, which is the same condition
 * the engine enforces on the headless path. The composer is not rendered at all here
 * rather than rendered-and-disabled: there is nothing to type into because nothing can
 * be sent, and an inert text box invites the user to try.
 *
 * BOTH credential routes are offered. A Rayu API key satisfies the gate exactly as an
 * account session does, so showing only "Sign in" would tell a user who already has a
 * working key that they are not authenticated.
 */
function SignInView({ state }: { state: WebviewState }): JSX.Element {
  return (
    <div className="rc-signin">
      <div className="rc-signin-mark" aria-hidden="true">
        <SparkleIcon size={26} />
      </div>
      <h2 className="rc-signin-title">Sign in to Rayu</h2>
      <p className="rc-signin-body">
        {state.signInMessage ?? 'You need to sign in to use Rayu.'}
      </p>

      <div className="rc-signin-actions">
        {state.oauthEnabled ? (
          <button
            type="button"
            className="rc-button rc-button-primary"
            onClick={() => send({ type: 'signIn' })}
          >
            Sign in with Rayu
          </button>
        ) : null}
        <button
          type="button"
          className="rc-button"
          onClick={() => send({ type: 'openProviderSetup' })}
        >
          Use an API key instead
        </button>
      </div>

      <p className="rc-signin-note">
        Signing in here also signs in the Rayu CLI — both share one credential.
      </p>
    </div>
  )
}
