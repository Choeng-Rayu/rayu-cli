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
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import type {
  EntryId,
  ImageInputView,
  HostToWebviewMessage,
  ThinkingEntryView,
  TurnCompletionEntry,
  TurnProgressView,
  WebviewState,
  WebviewToHostMessage,
} from '../shared/webviewProtocol.js'
import { permissionModeById } from '../shared/permissionModes.js'
import {
  describeCompletion,
  describeTurnPhase,
  formatDuration,
  isWaitingPhase,
  tokenReadouts,
} from '../shared/turnProgress.js'
import { chatReducer, initialChatState, type ChatState } from './state/reducer.js'
import { Composer } from './components/Composer.js'
import { ProviderSetupPanel } from './components/ProviderSetupPanel.js'
import { ModelChooserCard } from './components/ModelChooserCard.js'
import { SessionsView } from './components/SessionsView.js'
import { ApprovalStack } from './components/ApprovalStack.js'
import { TranscriptEntryView, NoticeEntry } from './components/TranscriptEntryView.js'
import { ActivityGroup } from './components/ActivityGroup.js'
import { groupTranscript } from './state/activityGroups.js'
import { WelcomeScreen } from './components/WelcomeScreen.js'
import { ScrollToBottomButton } from './components/ScrollToBottomButton.js'
import { isTodoToolEntry } from './components/TodoListCard.js'
import {
  BackgroundTaskBar,
  BackgroundTaskCenter,
} from './components/BackgroundTaskCenter.js'
import { RayuMark } from './components/Icons.js'
import {
  SessionHeader,
  deriveSessionStatus,
  deriveSessionTitle,
} from './components/SessionHeader.js'

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

/**
 * The slice of UI state that survives VS Code destroying the webview.
 *
 * Deliberately small and deliberately NOT the conversation: the host owns everything that
 * matters and re-sends it on `init`. What the host cannot know is what the user was doing in
 * the panel — whether they had the sessions list open, which task they were reading, and what
 * they had half-typed. Losing a draft to a panel collapse is the most annoying of those.
 */
interface PersistedUiState {
  sessionsOpen?: boolean
  selectedTaskKey?: string | null
  draft?: string
}

function readPersistedUi(): PersistedUiState {
  const raw = vscodeApi.getState()
  return raw && typeof raw === 'object' ? (raw as PersistedUiState) : {}
}

function send(message: WebviewToHostMessage): void {
  vscodeApi.postMessage(message)
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  /** Text a prompt chip put in the composer but the user has not sent. */
  const [draft, setDraft] = useState<string | null>(() => readPersistedUi().draft ?? null)
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    () => readPersistedUi().selectedTaskKey ?? null,
  )
  /** Which surface has replaced the conversation, if any. */
  const [sessionsOpen, setSessionsOpen] = useState(() => readPersistedUi().sessionsOpen ?? false)

  // One write per change, covering every persisted field: `setState` REPLACES rather than
  // merges, so writing them separately would have each field erase the others.
  useEffect(() => {
    vscodeApi.setState({
      sessionsOpen,
      selectedTaskKey,
      ...(draft ? { draft } : {}),
    } satisfies PersistedUiState)
  }, [sessionsOpen, selectedTaskKey, draft])

  /**
   * In-flight context-path requests, by `requestId`.
   *
   * Resolving a drop is asynchronous and the host owns the answer: only it can turn a
   * `vscode-remote://` URI into a path, recognise a folder, or run the file picker. So
   * this is a request/response pair over `postMessage`, correlated by id because two drops
   * can legitimately overlap.
   *
   * A ref rather than reducer state: these are transient continuations, not something the
   * UI renders, and putting them in state would grow it for every drop with nothing ever
   * removing the old entries. The host replies to EVERY request — including a cancelled
   * picker, with an empty list — so nothing accumulates here either.
   */
  const contextRequests = useRef(new Map<string, (paths: string[]) => void>())

  useEffect(() => {
    function onMessage(event: MessageEvent<HostToWebviewMessage>): void {
      const message = event.data

      // Correlated reply, not transcript state: hand it back to whoever asked.
      if (message.type === 'contextPathsResolved') {
        const resolve = contextRequests.current.get(message.requestId)
        contextRequests.current.delete(message.requestId)
        resolve?.(message.paths)
        return
      }

      // Composer text, not transcript state. Routed through the same `draft` the prompt
      // chips use, so it appends to whatever is already typed rather than replacing it.
      if (message.type === 'insertPrompt') {
        setDraft(current => (current ? `${current.replace(/\s*$/, '')}\n${message.text}` : message.text))
        return
      }

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
        case 'setModelChooser':
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
        case 'setIdeContext':
        case 'setSessions':
        case 'setTurnProgress':
        case 'turnCompleted':
        case 'updateThinking':
        case 'replaceTaskState':
        case 'upsertTaskState':
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
  // The transcript remains the host-owned source of truth. Selecting its newest
  // structured TodoWrite entry makes the list persistent across ordinary messages,
  // webview recreation, and history resume without a second todo state to synchronize.
  const latestTodoEntry = useMemo(() => {
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
      const entry = state.entries[index]
      if (entry && isTodoToolEntry(entry)) return entry
    }
    return null
  }, [state.entries])
  const composerCommands = signedOut
    ? state.commands.filter(command => command.name === 'login' || command.name === 'connect')
    : state.commands

  const submit = useCallback((text: string, images?: ImageInputView[]) => {
    setDraft(null)
    send({ type: 'submitPrompt', text, ...(images?.length ? { images } : {}) })
  }, [])

  /**
   * Ask the host to turn dropped resources, or a picker selection, into workspace paths.
   *
   * Both requests share one reply message, so they share one correlation map. The returned
   * promise always settles because the host always replies.
   */
  const requestContextPaths = useCallback(
    (request: (requestId: string) => WebviewToHostMessage): Promise<string[]> =>
      new Promise<string[]>(resolve => {
        const requestId = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        contextRequests.current.set(requestId, resolve)
        send(request(requestId))
      }),
    [],
  )

  const resolveDroppedPaths = useCallback(
    (uriList: string) =>
      requestContextPaths(requestId => ({ type: 'resolveContextPaths', requestId, uriList })),
    [requestContextPaths],
  )

  const pickContextPaths = useCallback(
    () => requestContextPaths(requestId => ({ type: 'pickContextPaths', requestId })),
    [requestContextPaths],
  )

  // Stable reference: the Composer's useEffect depends on this callback, and an
  // inline arrow would fire the effect on every App re-render — which the effect
  // itself triggers (findFiles → fileSearchResults → workspaceFiles change →
  // re-render → new ref → effect again). useCallback breaks that loop.
  const findFiles = useCallback((query: string) => {
    send({ type: 'findFiles', query })
  }, [])

  // Stable, because the header fetches MCP status from an effect keyed on this callback.
  const refreshMcp = useCallback(() => {
    send({ type: 'getMcpStatus' })
  }, [])

  const sessionTitle = useMemo(() => deriveSessionTitle(state.entries), [state.entries])
  const sessionStatus = deriveSessionStatus(
    state.turnRunning,
    state.turnProgress,
    state.pendingPermissions.length,
  )

  return (
    <div className="rc-shell">
      <SessionHeader
        ready={session !== null}
        signedOut={signedOut}
        identity={session?.identity ?? null}
        version={session?.version ?? ''}
        title={sessionTitle}
        status={sessionStatus}
        mcpServers={state.mcpServers}
        onBack={sessionsOpen ? () => setSessionsOpen(false) : undefined}
        onNewSession={() => {
          // A new session invalidates selections that referred to the old one.
          setSessionsOpen(false)
          setSelectedTaskKey(null)
          send({ type: 'newSession' })
        }}
        onOpenSessions={() => {
          setSessionsOpen(open => !open)
          // Refetched on every open: sessions accumulate from the CLI and other windows
          // while the panel sits idle, so a cached list goes stale invisibly.
          send({ type: 'listSessions' })
        }}
        onOpenProviderSetup={() => send({ type: 'openProviderSetup' })}
        onRefreshMcp={refreshMcp}
        onReconnectMcp={serverName => send({ type: 'mcpReconnect', serverName })}
        onToggleMcp={(serverName, enabled) => send({ type: 'mcpToggle', serverName, enabled })}
        onSignOut={() => send({ type: 'signOut' })}
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

      <div
        className={`rc-main-area${taskCenterOpen ? ' rc-main-area-tasks' : ''}${
          sessionsOpen ? ' rc-main-area-sessions' : ''
        }`}
      >
        <Transcript state={state} onPick={setDraft} signedOut={signedOut} />
        {sessionsOpen ? (
          <SessionsView
            list={state.sessions}
            hasActiveTranscript={state.entries.length > 0}
            workspaceFolder={session?.workspaceFolder ?? ''}
            onResume={id => {
              setSessionsOpen(false)
              setSelectedTaskKey(null)
              send({ type: 'resumeSession', id })
            }}
            onRetry={() => send({ type: 'listSessions' })}
          />
        ) : null}
        {taskCenterOpen ? (
          <BackgroundTaskCenter
            tasks={state.backgroundTasks}
            supported={state.taskInspectionSupported}
            message={state.taskInspectionMessage}
            selectedKey={selectedTaskKey}
            onSelect={setSelectedTaskKey}
            onClose={() => setTaskCenterOpen(false)}
            onStop={task => send({
              type: 'stopTask',
              sourceSessionId: task.sourceSessionId,
              taskId: task.taskId,
            })}
            onSend={(task, text) => send({
              type: 'sendTaskMessage',
              sourceSessionId: task.sourceSessionId,
              taskId: task.taskId,
              text,
            })}
            permissions={state.pendingPermissions}
          />
        ) : null}
      </div>

      {/* Pinned between the transcript and the composer: the engine is blocked, so
          this must be visible without scrolling, while the transcript it describes
          stays readable. */}
      {state.modelChooser ? (
        <ModelChooserCard
          chooser={state.modelChooser}
          catalogue={state.modelCatalogue}
          onChoose={value =>
            send({
              type: 'modelChooserChoice',
              target: state.modelChooser!.target,
              ...(state.modelChooser!.agentType
                ? { agentType: state.modelChooser!.agentType }
                : {}),
              value,
            })
          }
          onDismiss={() => send({ type: 'modelChooserDismiss' })}
          onRefresh={() => send({ type: 'refreshModelCatalogue' })}
        />
      ) : null}

      <ApprovalStack
        requests={state.pendingPermissions}
        onAnswerQuestions={(requestId, answers, notes) =>
          send({ type: 'questionResponse', requestId, answers, notes })
        }
        onDecide={(requestId, decision) =>
          send({ type: 'permissionResponse', requestId, decision })
        }
      />

      <BackgroundTaskBar
        tasks={state.backgroundTasks}
        open={taskCenterOpen}
        supported={state.taskInspectionSupported}
        message={state.taskInspectionMessage}
        onToggle={() => {
          setTaskCenterOpen(open => !open)
          if (!selectedTaskKey && state.backgroundTasks[0]) {
            setSelectedTaskKey(state.backgroundTasks[0].key)
          }
        }}
      />

      <Composer
        key={draft ?? ''}
        initialValue={draft ?? ''}
        disabled={false}
        authenticationRequired={signedOut}
        turnRunning={state.turnRunning}
        modelInfo={state.modelInfo}
        modelCatalogue={state.modelCatalogue}
        inference={state.inference}
        permissionMode={state.permissionMode}
        commands={composerCommands}
        workspaceFiles={state.workspaceFiles}
        ideContext={state.ideContext}
        contextUsage={state.contextUsage}
        attachment={state.attachment}
        onListAttachable={() => send({ type: 'listAttachable' })}
        onAttachSession={pid => send({ type: 'attachToSession', pid })}
        onDetachSession={() => send({ type: 'detachFromSession' })}
        todoEntry={latestTodoEntry}
        onSubmit={submit}
        onInterrupt={() => send({ type: 'interrupt' })}
        onSelectModel={value => send({ type: 'selectModelValue', value })}
        onRefreshModels={() => send({ type: 'refreshModelCatalogue' })}
        onSetEffort={level => send({ type: 'setEffort', level })}
        onCyclePermissionMode={() => send({ type: 'cyclePermissionMode' })}
        onSelectPermissionMode={modeId => {
          dispatch({ type: 'setPermissionMode', mode: permissionModeById(modeId) })
          send({ type: 'setPermissionMode', modeId })
        }}
        onOpenProviderSetup={() => send({ type: 'openProviderSetup' })}
        onFindFiles={findFiles}
        onResolveDroppedPaths={resolveDroppedPaths}
        onPickContextPaths={pickContextPaths}
      />
    </div>
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
  const [showScrollBottom, setShowScrollBottom] = useState(false)

  /**
   * Reasoning blocks bucketed by the assistant entry they belong in front of.
   *
   * Built once per change rather than filtered inside the entry loop, which would be
   * O(entries × blocks) on every delta of a long conversation. Sorted by `blockIndex` so
   * several reasoning blocks in one message keep the order the provider produced them in.
   */
  /**
   * The transcript folded into renderable blocks.
   *
   * Derived here rather than stored: grouping is a PRESENTATION decision, and putting it in
   * the reducer would mean the webview held a second, differently-shaped copy of a transcript
   * the host owns.
   */
  const blocks = useMemo(() => groupTranscript(state.entries), [state.entries])

  const thinkingByEntry = useMemo(() => {
    const grouped = new Map<EntryId, ThinkingEntryView[]>()
    for (const block of Object.values(state.thinkingBlocks)) {
      const bucket = grouped.get(block.sourceMessageId)
      if (bucket) bucket.push(block)
      else grouped.set(block.sourceMessageId, [block])
    }
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => a.blockIndex - b.blockIndex)
    }
    return grouped
  }, [state.thinkingBlocks])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    // 48px of slack: an exact comparison unpins on sub-pixel scroll positions.
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinned.current = isNearBottom
    setShowScrollBottom(!isNearBottom && el.scrollHeight - el.clientHeight > 100)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinned.current = true
    setShowScrollBottom(false)
  }, [])

  useEffect(() => {
    if (!pinned.current) return
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.entries, state.notices])

  const session = state.session

  return (
    <div className="rc-transcript-wrapper">
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
        ) : session.status === 'signed-out' && state.entries.length === 0 ? (
          <SignInView state={session} />
        ) : state.entries.length === 0 ? (
          <WelcomeScreen onPick={onPick} disabled={signedOut} />
        ) : (
          <>
            {session.status === 'signed-out' ? <SignInView state={session} /> : null}
            {blocks.map(block =>
              block.kind === 'activity' ? (
                <ActivityGroup
                  key={block.id}
                  activity={block.activity}
                  tools={block.tools}
                />
              ) : (
                <TranscriptEntryView
                  key={block.entry.id}
                  entry={block.entry}
                  thinking={thinkingByEntry.get(block.entry.id)}
                  onKeep={path => send({ type: 'reviewKeep', path })}
                  onUndo={path => send({ type: 'reviewUndo', path })}
                  onDiff={path => send({ type: 'openReviewDiff', path })}
                  onOpen={path => send({ type: 'openFile', path })}
                />
              ),
            )}
            {state.turnProgress ? (
              <TurnStatus
                running={state.turnRunning}
                progress={state.turnProgress}
                completion={state.turnCompletions[state.turnProgress.turnId]}
              />
            ) : null}
          </>
        )}

        {state.notices.map((notice, index) => (
          <NoticeEntry key={`notice-${index}`} text={notice} severity="error" />
        ))}
      </main>

      <ScrollToBottomButton visible={showScrollBottom} onClick={scrollToBottom} />
    </div>
  )
}

/**
 * The live progress line, and the completion line that replaces it.
 *
 * ── THE HOST OWNS THE FACTS; THIS OWNS THE TICK ────────────────────────────────
 *
 * Every value shown — the phase, its wording, the token counts, the start instant —
 * comes from the host, which derives them from the engine's own stream events. The only
 * thing computed here is the elapsed seconds, counted from `startTimestamp` by a single
 * one-second interval. Having the host push elapsed time instead would be one message
 * per second per panel for information already derivable, and it would reset the count
 * every time VS Code re-created the webview.
 *
 * ── WHY THE COUNTER IS KEYED ON `turnId` ───────────────────────────────────────
 *
 * `startTimestamp` is read on every render rather than captured once in state. An
 * earlier version captured `Date.now()` in `useState`, which meant the count started
 * when the COMPONENT mounted rather than when the turn began — so a panel opened
 * mid-turn showed a few seconds for a turn that had been running for minutes.
 *
 * Live:      ◌ Thinking… 32s · ↑ 12.8k · ↓ ~1.4k
 * Completed: ✓ Completed in 1m 23s · ↑ 12.8k input · ↓ 4.3k output
 */
function TurnStatus({
  running,
  progress,
  completion,
}: {
  running: boolean
  progress: TurnProgressView
  completion: TurnCompletionEntry | undefined
}): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  // A finished turn shows the ENGINE's duration and usage, not the host's observation of
  // them: `completion` carries `result.duration_ms` where the engine reported one.
  if (!running && completion) {
    const { glyph, text, tone } = describeCompletion(completion)
    const readouts = tokenReadouts(completion.usage)
    return (
      <div className={`rc-working rc-turn-done rc-turn-done-${tone}`}>
        <span className="rc-turn-glyph" aria-hidden="true">{glyph}</span>
        <span className="rc-thinking-text">
          {text}
          {readouts.map(readout => (
            <span key={readout.direction} className="rc-token-readout" title={readout.title}>
              {' · '}
              <span aria-hidden="true">{readout.direction}</span>{' '}
              {readout.text} {readout.direction === '\u2191' ? 'input' : 'output'}
            </span>
          ))}
        </span>
      </div>
    )
  }

  if (!running) return null

  const readouts = tokenReadouts(progress.usage)
  const elapsed = Math.max(0, now - progress.startTimestamp)
  const waiting = isWaitingPhase(progress.phase)

  return (
    <div className="rc-working" role="status" aria-live="polite">
      {/*
        A static glyph while WAITING. The engine is blocked on the user there, and an
        animated spinner would claim progress that cannot happen until they answer.
      */}
      <span
        className={waiting ? 'rc-turn-glyph rc-turn-glyph-waiting' : 'rc-progress-glyph'}
        aria-hidden="true"
      />
      <span className="rc-thinking-text">
        {describeTurnPhase(progress)}
        {'\u2026 '}
        {formatDuration(elapsed)}
        {readouts.map(readout => (
          <span key={readout.direction} className="rc-token-readout" title={readout.title}>
            {' · '}
            <span aria-hidden="true">{readout.direction}</span> {readout.text}
          </span>
        ))}
      </span>
    </div>
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
        <RayuMark size={26} />
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
        Rayucode uses its own sign-in and provider credentials. Your Rayu CLI login is
        unchanged.
      </p>
    </div>
  )
}
