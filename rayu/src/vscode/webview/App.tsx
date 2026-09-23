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
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, memo, type MutableRefObject } from 'react'

import type {
  EntryId,
  ImageInputView,
  PromptDeliveryView,
  RuntimeSectionView,
  ComposerControlView,
  HostToWebviewMessage,
  ThinkingEntryView,
  TurnProgressView,
  WebviewState,
  WebviewToHostMessage,
} from '../shared/webviewProtocol.js'
import { permissionModeById } from '../shared/permissionModes.js'
import {
  describeTurnPhase,
  formatDuration,
  tokenReadouts,
} from '../shared/turnProgress.js'
import { spriteStateForPhase } from './spriteAtlas.js'
import { chatReducer, initialChatState, type ChatState } from './state/reducer.js'
import { Composer } from './components/Composer.js'
import { ProviderSetupPanel } from './components/ProviderSetupPanel.js'
import { ModelChooserCard } from './components/ModelChooserCard.js'
import { SessionsView } from './components/SessionsView.js'
import { ApprovalStack } from './components/ApprovalStack.js'
import { McpElicitationStack } from './components/McpElicitationStack.js'
import { RuntimeStatusBar } from './components/RuntimeStatusBar.js'
import { RuntimeCenter } from './components/RuntimeCenter.js'
import { TranscriptEntryView, NoticeEntry } from './components/TranscriptEntryView.js'
import { ActivityGroup } from './components/ActivityGroup.js'
import { groupTranscript } from './state/activityGroups.js'
import { useSecondTick } from './useSecondTick.js'
import { createSessionScrollMemory, createScrollSwitchTracker } from './sessionScrollMemory.js'
import { promptHistoryFromTranscript } from './promptHistory.js'
import { WelcomeScreen } from './components/WelcomeScreen.js'
import { ScrollToBottomButton } from './components/ScrollToBottomButton.js'
import { isTodoToolEntry } from './components/TodoListCard.js'
import {
  BackgroundTaskBar,
  BackgroundTaskCenter,
  type TaskOutputResult,
} from './components/BackgroundTaskCenter.js'
import { ProgressGlyph, RayuMark } from './components/Icons.js'
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
  /** Whether a drag is currently over the panel. Owned here so the overlay can cover it. */
  const [panelDragging, setPanelDragging] = useState(false)
  const [taskCenterOpen, setTaskCenterOpen] = useState(false)
  const [runtimeCenterOpen, setRuntimeCenterOpen] = useState(false)
  const [runtimeSection, setRuntimeSection] = useState<RuntimeSectionView>('commands')
  const [composerControlRequest, setComposerControlRequest] = useState<{
    control: ComposerControlView
    revision: number
  } | null>(null)
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    () => readPersistedUi().selectedTaskKey ?? null,
  )
  /** Which surface has replaced the conversation, if any. */
  const [sessionsOpen, setSessionsOpen] = useState(() => readPersistedUi().sessionsOpen ?? false)
  const captureReadingRef = useRef<() => void>(() => {})
  /**
   * Whether every tool row shows its fields and output.
   *
   * The panel-wide analogue of the CLI's Ctrl+O.
   *
   * ── DELIBERATELY NOT PERSISTED ─────────────────────────────────────────────────
   *
   * It used to be, on the reasoning that a reading preference should survive the webview
   * being recreated. In practice that made it a trap: one press of Ctrl+O turned every row
   * in every future session permanently open, `vscode.setState` outlives an extension
   * update so reinstalling did not clear it, and nothing on screen explained why the
   * transcript was full of expanded output. The collapsed row IS the design — a one-line
   * summary per action — so the panel starts there every time and this stays a per-session
   * "show me everything for a moment".
   */
  const [detailed, setDetailed] = useState(false)
  /**
   * Tool rows the user has opened or closed BY HAND, overriding the panel switch.
   *
   * ── WHY THIS IS LIFTED OUT OF THE ROW ──────────────────────────────────────────
   *
   * `<details open>` is a DOM attribute the browser mutates itself on click, so React's
   * virtual DOM goes out of step with it and re-rendering with the same `open` value
   * leaves the element wherever the user put it. The previous fix was to key the element
   * on `detailed`, which remounted every row whenever the switch flipped — and that threw
   * away every manual toggle the user had made, including on rows they had deliberately
   * collapsed while reading.
   *
   * Holding the overrides here instead makes `open` fully controlled: the switch sets the
   * default, an override wins over it, and flipping the switch clears the overrides so it
   * behaves like a fresh instruction rather than being silently ignored on some rows.
   *
   * Not persisted. Which rows were open is transient reading state, and neither is the
   * panel-wide switch any more — see `detailed`.
   */
  const [toolOverrides, setToolOverrides] = useState<Record<EntryId, boolean>>({})

  const toggleTool = useCallback((id: EntryId, open: boolean) => {
    setToolOverrides(current => ({ ...current, [id]: open }))
  }, [])

  // A new instruction from the panel-wide switch supersedes per-row choices. Without
  // this, turning Details on would leave previously-collapsed rows shut and the control
  // would look like it had failed on exactly the rows the user had touched.
  useEffect(() => {
    setToolOverrides({})
  }, [detailed])

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
   * Ctrl+O / Cmd+O, the same gesture the CLI uses for the same thing.
   *
   * An accelerator for the header control, not the only way in — see that control for why.
   * Registered on `document` because the composer's textarea holds focus for most of a
   * session, and a handler on the shell would never see the key.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'o' && event.key !== 'O') return
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey || event.shiftKey) return
      event.preventDefault()
      setDetailed(current => !current)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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

  /**
   * In-flight full-output requests, by `requestId`.
   *
   * Separate from `contextRequests` only because the payloads differ; the discipline is
   * identical, including that the host always replies so nothing accumulates here.
   */
  const outputRequests = useRef(new Map<string, (text: string | null) => void>())

  const requestToolOutput = useCallback(
    (entryId: EntryId): Promise<string | null> =>
      new Promise<string | null>(resolve => {
        const requestId = `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        outputRequests.current.set(requestId, resolve)
        send({ type: 'requestToolOutput', requestId, entryId })
      }),
    [],
  )

  /**
   * A background task's recorded output.
   *
   * Same correlation map as the tool-row request above — one mechanism for "ask the host
   * something and await it" — but its own resolver signature, because this answer can
   * carry a failure reason and a truncation flag rather than only text.
   */
  const taskOutputRequests = useRef(
    new Map<string, (result: TaskOutputResult) => void>(),
  )

  const requestTaskOutput = useCallback(
    (taskKey: string): Promise<TaskOutputResult> =>
      new Promise<TaskOutputResult>(resolve => {
        const requestId = `task-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        taskOutputRequests.current.set(requestId, resolve)
        send({ type: 'requestTaskOutput', requestId, taskKey })
      }),
    [],
  )

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

      // Same request/response shape as the context paths above, so it uses the same
      // correlation map — one mechanism for "ask the host something and await it".
      if (message.type === 'toolOutputResolved') {
        const resolve = outputRequests.current.get(message.requestId)
        outputRequests.current.delete(message.requestId)
        resolve?.(message.text)
        return
      }

      if (message.type === 'taskOutputResolved') {
        const resolve = taskOutputRequests.current.get(message.requestId)
        taskOutputRequests.current.delete(message.requestId)
        resolve?.({
          text: message.text,
          truncated: message.truncated === true,
          error: message.error,
        })
        return
      }

      // Composer text, not transcript state. Routed through the same `draft` the prompt
      // chips use, so it appends to whatever is already typed rather than replacing it.
      if (message.type === 'insertPrompt') {
        setDraft(current => (current ? `${current.replace(/\s*$/, '')}\n${message.text}` : message.text))
        return
      }

      if (message.type === 'openRuntimeCenter') {
        setRuntimeSection(message.section)
        setRuntimeCenterOpen(true)
        return
      }

      if (message.type === 'openTaskCenter') {
        setTaskCenterOpen(true)
        return
      }

      if (message.type === 'openComposerControl') {
        setComposerControlRequest(current => ({
          control: message.control,
          revision: (current?.revision ?? 0) + 1,
        }))
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
        case 'setCommands':
        case 'fileSearchResults':
        case 'setContextUsage':
        case 'setMcpServers':
        case 'setMcpConnectionUi':
        case 'setRuntimeCatalogue':
        case 'setRateLimit':
        case 'setEngineAuthStatus':
        case 'setSessionStatus':
        case 'setPromptSuggestion':
        case 'showMcpElicitation':
        case 'dismissMcpElicitation':
        case 'setIdeContext':
        case 'setSessions':
        case 'setLiveSessions':
        case 'setTurnProgress':
        case 'turnCompleted':
        case 'updateThinking':
        case 'appendToolOutput':
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
  const promptHistory = useMemo(
    () => promptHistoryFromTranscript(state.entries),
    [state.entries],
  )

  const submit = useCallback((
    text: string,
    images?: ImageInputView[],
    delivery?: PromptDeliveryView,
  ) => {
    setDraft(null)
    send({
      type: 'submitPrompt',
      text,
      ...(images?.length ? { images } : {}),
      ...(delivery ? { delivery } : {}),
    })
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

  const sessionTitle = state.customTitle ?? deriveSessionTitle(state.entries)
  const sessionStatus = deriveSessionStatus(
    state.turnRunning,
    state.turnProgress,
    state.pendingPermissions.length + state.mcpElicitations.length,
  )

  return (
    <div className={`rc-shell${panelDragging ? ' rc-shell-drag-over' : ''}${runtimeCenterOpen ? ' rc-shell-runtime-open' : ''}`}>
      {/*
        The drop target covers the PANEL, because the handler does. An overlay confined to
        the composer strip was the visible half of the original bug: a drop on the
        conversation was accepted with no highlight, and a drop the platform had already
        taken away looked identical.

        `pointer-events: none` in CSS is load-bearing — an overlay that swallowed the
        pointer would prevent the very `drop` it advertises.
      */}
      {panelDragging ? (
        <div className="rc-panel-drop-overlay" aria-hidden="true">
          <div className="rc-panel-drop-inner">
            <span className="rc-panel-drop-icon">@</span>
            <span className="rc-panel-drop-text">Drop to attach</span>
            <span className="rc-panel-drop-hint">
              Files and folders are referenced by path; images are attached.
            </span>
          </div>
        </div>
      ) : null}
      <SessionHeader
        ready={session !== null}
        signedOut={signedOut}
        identity={session?.identity ?? null}
        version={session?.version ?? ''}
        title={sessionTitle}
        activeSessionKey={state.activeSessionKey}
        onRename={title => send({ type: 'renameSession', key: state.activeSessionKey, title })}
        status={sessionStatus}
        mcpServers={state.mcpServers}
        mcpConnectionUi={state.mcpConnectionUi}
        onBack={sessionsOpen ? () => setSessionsOpen(false) : undefined}
        onNewSession={() => {
          captureReadingRef.current()
          // A new session invalidates selections that referred to the old one.
          setSessionsOpen(false)
          setSelectedTaskKey(null)
          send({ type: 'newSession' })
        }}
        onOpenSessions={() => {
          if (!sessionsOpen) captureReadingRef.current()
          setSessionsOpen(open => !open)
          // Refetched on every open: sessions accumulate from the CLI and other windows
          // while the panel sits idle, so a cached list goes stale invisibly.
          send({ type: 'listSessions' })
        }}
        detailed={detailed}
        onToggleDetailed={() => setDetailed(current => !current)}
        openSessionCount={state.liveSessions.length}
        backgroundTaskCount={state.backgroundTasks.length}
        backgroundOpen={taskCenterOpen}
        onToggleBackground={() => {
          setTaskCenterOpen(open => !open)
          if (!selectedTaskKey && state.backgroundTasks[0]) {
            setSelectedTaskKey(state.backgroundTasks[0].key)
          }
        }}
        onOpenProviderSetup={() => send({ type: 'openProviderSetup' })}
        onRefreshMcp={refreshMcp}
        onOpenMcp={() => {
          setRuntimeSection('mcp')
          setRuntimeCenterOpen(true)
        }}
        onReconnectMcp={serverName => send({ type: 'mcpReconnect', serverName })}
        onAuthenticateMcp={serverName => send({ type: 'mcpAuthenticate', serverName })}
        onToggleMcp={(serverName, enabled) => send({ type: 'mcpToggle', serverName, enabled })}
        onSignIn={() => send({ type: 'signIn' })}
        onSignOut={() => send({ type: 'signOut' })}
      />

      <RuntimeStatusBar
        authentication={state.engineAuthStatus}
        rateLimit={state.rateLimit}
        resourceCount={
          state.runtimeCommands.length +
          state.runtimeTools.length +
          state.runtimeAgents.length +
          state.runtimePlugins.length +
          state.runtimeSkills.length
        }
        open={runtimeCenterOpen}
        onOpenRuntime={() => setRuntimeCenterOpen(open => !open)}
        // The Rayu pacing switch lives in the web dashboard, so the in-editor
        // action is the same link the CLI offers. The URL comes from the HOST
        // (which can resolve it in Node) via the rate-limit view; the webview must
        // not import the session helpers itself. Reuses the existing openExternal
        // channel rather than adding a host→engine round trip.
        onOpenPacingDashboard={
          state.rateLimit?.rayuPacingDashboardUrl
            ? () =>
                send({
                  type: 'openExternal',
                  url: state.rateLimit!.rayuPacingDashboardUrl!,
                })
            : undefined
        }
      />

      {runtimeCenterOpen ? (
        <RuntimeCenter
          key={runtimeSection}
          initialSection={runtimeSection}
          commands={state.runtimeCommands}
          tools={state.runtimeTools}
          mcpServers={state.mcpServers}
          mcpConnectionUi={state.mcpConnectionUi}
          agents={state.runtimeAgents}
          plugins={state.runtimePlugins}
          skills={state.runtimeSkills}
          workflows={state.runtimeWorkflows}
          onClose={() => setRuntimeCenterOpen(false)}
          onUseCommand={name => {
            setDraft(`/${name} `)
            setRuntimeCenterOpen(false)
          }}
          onRefreshMcp={refreshMcp}
          onReconnectMcp={serverName => send({ type: 'mcpReconnect', serverName })}
          onToggleMcp={(serverName, enabled) => send({ type: 'mcpToggle', serverName, enabled })}
          onAuthenticateMcp={serverName => send({ type: 'mcpAuthenticate', serverName })}
          onClearMcpAuth={serverName => send({ type: 'mcpClearAuth', serverName })}
          onPasteMcpCallback={serverName => send({ type: 'mcpPasteCallback', serverName })}
        />
      ) : null}

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
        <Transcript
          state={state}
          sessionsOpen={sessionsOpen}
          captureReadingRef={captureReadingRef}
          onPick={setDraft}
          signedOut={signedOut}
          detailed={detailed}
          toolOverrides={toolOverrides}
          onToggleTool={toggleTool}
          onRequestToolOutput={requestToolOutput}
        />
        {sessionsOpen ? (
          <SessionsView
            list={state.sessions}
            liveSessions={state.liveSessions}
            activeSessionKey={state.activeSessionKey}
            workspaceFolder={session?.workspaceFolder ?? ''}
            onResume={id => {
              setSessionsOpen(false)
              setSelectedTaskKey(null)
              send({ type: 'resumeSession', id })
            }}
            onSwitch={key => {
              setSessionsOpen(false)
              setSelectedTaskKey(null)
              send({ type: 'switchSession', key })
            }}
            onClose={key => send({ type: 'closeSession', key })}
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
            onRequestOutput={requestTaskOutput}
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
          onTargetChange={agentType =>
            send({
              type: 'modelChooserTarget',
              ...(agentType ? { agentType } : {}),
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

      <McpElicitationStack
        requests={state.mcpElicitations}
        onRespond={(requestId, action, content) =>
          send({
            type: 'mcpElicitationResponse',
            requestId,
            action,
            ...(content ? { content } : {}),
          })
        }
        onOpenExternal={url => send({ type: 'openExternal', url })}
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
        agents={state.runtimeAgents}
        promptHistory={promptHistory}
        workspaceFiles={state.workspaceFiles}
        ideContext={state.ideContext}
        contextUsage={state.contextUsage}
        attachment={state.attachment}
        onListAttachable={() => send({ type: 'listAttachable' })}
        onAttachSession={pid => send({ type: 'attachToSession', pid })}
        onDetachSession={() => send({ type: 'detachFromSession' })}
        todoEntry={latestTodoEntry}
        promptSuggestion={state.promptSuggestion}
        onSubmit={submit}
        onInterrupt={() => send({ type: 'interrupt' })}
        onSelectModel={value => send({ type: 'selectModelValue', value })}
        onRefreshModels={() => send({ type: 'refreshModelCatalogue' })}
        onSetEffort={level => send({ type: 'setEffort', level })}
        onSetThinking={enabled => send({ type: 'setThinking', enabled })}
        onCyclePermissionMode={() => send({ type: 'cyclePermissionMode' })}
        onSelectPermissionMode={modeId => {
          dispatch({ type: 'setPermissionMode', mode: permissionModeById(modeId) })
          send({ type: 'setPermissionMode', modeId })
        }}
        onOpenProviderSetup={() => send({ type: 'openProviderSetup' })}
        onFindFiles={findFiles}
        onResolveDroppedPaths={resolveDroppedPaths}
        onPickContextPaths={pickContextPaths}
        onDragStateChange={setPanelDragging}
        controlRequest={composerControlRequest}
      />
    </div>
  )
}

/**
 * One memoized transcript block.
 *
 * The host bounds restored history to its newest 400 blocks. Keeping those blocks in normal
 * layout gives the scroller an exact height even when messages, diffs, and tool results vary
 * dramatically in size. Do not add `content-visibility` here: Chromium substitutes an
 * intrinsic placeholder for unseen blocks, then moves the bottom as they become visible.
 * That made long histories appear to load another page whenever the user scrolled down.
 *
 * Memoization still matters during streaming: only the block being appended to reconciles,
 * while completed blocks with identical props stop here.
 */
const TranscriptBlock = memo(function TranscriptBlock({
  children,
}: {
  children: React.ReactNode
}): JSX.Element {
  return <div className="rc-block">{children}</div>
})

/**
 * The scrolling conversation.
 *
 * Auto-scroll follows the newest entry ONLY when the user is already near the bottom.
 * Scrolling them back down while they are reading earlier output is one of the most
 * irritating things a streaming transcript can do.
 */
function Transcript({
  state,
  sessionsOpen,
  captureReadingRef,
  onPick,
  signedOut,
  detailed,
  toolOverrides,
  onToggleTool,
  onRequestToolOutput,
}: {
  state: ChatState
  sessionsOpen: boolean
  captureReadingRef: MutableRefObject<() => void>
  onPick: (text: string) => void
  signedOut: boolean
  /** Panel-wide detail switch, forwarded to every tool row. */
  detailed: boolean
  /** Per-row manual open/closed choices that outrank the switch. See App. */
  toolOverrides: Record<EntryId, boolean>
  onToggleTool: (id: EntryId, open: boolean) => void
  /** Fetch a row's untruncated output from the host. Always settles. */
  onRequestToolOutput: (id: EntryId) => Promise<string | null>
}): JSX.Element {
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  /**
   * The reading position of every open conversation, keyed by the panel's session key.
   * See `sessionScrollMemory` for why this belongs to the conversation and not the panel.
   */
  const scrollMemory = useRef(createSessionScrollMemory())
  // Which conversation the next scroll should be credited to. A ref, so `onScroll` stays
  // stable; repointed on a switch by the restore effect below, and only AFTER the restore,
  // so an event already in flight is still credited to the conversation being left.
  const scrollSwitch = useRef(createScrollSwitchTracker(state.activeSessionKey))
  const suppressScroll = useRef(false)
  const pendingCapture = useRef(false)
  const bottomSettleRevision = useRef(0)

  /**
   * Keep a restored conversation pinned through its first layout frames. Text blocks now
   * lay out eagerly, so scrollHeight is authoritative; fonts, images, and expandable content
   * can still make a small late adjustment after the transcript first becomes visible.
   */
  const settleAtBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const revision = ++bottomSettleRevision.current
    let previousHeight = -1
    let frame = 0
    let stableFrames = 0
    suppressScroll.current = true
    pinned.current = true

    const align = (): void => {
      if (revision !== bottomSettleRevision.current || !pinned.current) return
      const height = el.scrollHeight
      el.scrollTop = height
      frame += 1
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height

      if (frame < 4 || (frame < 12 && stableFrames < 2)) {
        requestAnimationFrame(align)
        return
      }
      suppressScroll.current = false
      pendingCapture.current = false
      scrollMemory.current.remember(scrollSwitch.current.key, {
        top: el.scrollTop,
        pinned: true,
      })
    }

    align()
  }, [])

  /** Restore a saved non-bottom position after the same initial layout settling. */
  const settleAtPosition = useCallback((top: number) => {
    const el = scroller.current
    if (!el) return
    const revision = ++bottomSettleRevision.current
    let previousHeight = -1
    let frame = 0
    let stableFrames = 0
    suppressScroll.current = true
    pinned.current = false

    const align = (): void => {
      if (revision !== bottomSettleRevision.current || pinned.current) return
      const height = el.scrollHeight
      el.scrollTop = top
      frame += 1
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height

      if (frame < 4 || (frame < 12 && stableFrames < 2)) {
        requestAnimationFrame(align)
        return
      }
      suppressScroll.current = false
      pendingCapture.current = false
      scrollMemory.current.remember(scrollSwitch.current.key, {
        top: el.scrollTop,
        pinned: false,
      })
      setShowScrollBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 100)
    }

    align()
  }, [])

  captureReadingRef.current = () => {
    const el = scroller.current
    if (!el || el.getClientRects().length === 0) return
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    scrollMemory.current.remember(scrollSwitch.current.key, { top: el.scrollTop, pinned: isNearBottom })
    pendingCapture.current = true
  }

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
    if (!el || el.getClientRects().length === 0 || suppressScroll.current || pendingCapture.current) return
    // 48px of slack: an exact comparison unpins on sub-pixel scroll positions.
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinned.current = isNearBottom
    if (!isNearBottom) bottomSettleRevision.current += 1
    // Remember where this conversation was left, as it is read. Recorded here rather than
    // on the way out, because by the time a switch is observable the content is already
    // replaced and `scrollTop` is whatever the browser clamped it to.
    scrollMemory.current.remember(scrollSwitch.current.key, { top: el.scrollTop, pinned: isNearBottom })
    setShowScrollBottom(!isNearBottom && el.scrollHeight - el.clientHeight > 100)  }, [])

  /**
   * Put the reader back where this conversation was left.
   *
   * ── A LAYOUT EFFECT, AND THAT IS THE LOAD-BEARING PART ─────────────────────────
   *
   * Replacing the transcript empties the scroll container for an instant, so the browser
   * clamps `scrollTop` and queues a scroll event. A layout effect runs during the commit,
   * before that event is dispatched: the position is restored and `scrollKey` is repointed
   * while any in-flight event is still credited to the OUTGOING conversation. A passive
   * effect would run after the clamp, so the outgoing conversation's remembered position
   * would be overwritten with the clamp and coming back to it would land at the top again
   * — the exact bug this fixes.
   *
   * A conversation with no remembered position opens at the newest output, which is what a
   * fresh conversation and a first visit both want. The follow effect below is passive, so
   * it runs after this one and cannot undo the restore: it returns early whenever the
   * reader was not pinned, which is exactly the restored-mid-transcript case.
   */
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (!scrollSwitch.current.shouldRestore(state.activeSessionKey, el.getClientRects().length > 0)) {
      if (!sessionsOpen && pendingCapture.current) {
        requestAnimationFrame(() => { pendingCapture.current = false })
      }
      return
    }
    suppressScroll.current = true
    const saved = scrollMemory.current.recall(state.activeSessionKey)
    if (saved && !saved.pinned) {
      settleAtPosition(saved.top)
    } else {
      settleAtBottom()
    }
    setShowScrollBottom(!pinned.current && el.scrollHeight - el.clientHeight > 100)
  }, [state.activeSessionKey, sessionsOpen, state.entries, settleAtBottom, settleAtPosition])

  // Forget conversations that are no longer open. The live list is the only key writer,
  // so this holds the memory at the number of open conversations rather than at however
  // many the user has ever opened.
  useEffect(() => {
    scrollMemory.current.retainOnly(state.liveSessions.map(session => session.key))
  }, [state.liveSessions])

  const scrollToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    pinned.current = true
    setShowScrollBottom(false)
  }, [])

  /**
   * Follow the newest output, but only while the user is already at the bottom.
   *
   * ── EVERY STREAMING CHANNEL MUST BE A DEPENDENCY ───────────────────────────────
   *
   * Assistant text grows `entries`, so text streaming scrolled correctly. Reasoning does
   * NOT: `updateThinking` writes only to `thinkingBlocks`, so a long thinking block grew
   * downward off the bottom of a pinned transcript with nothing to trigger a scroll. The
   * live status line moves for the same reason — its elapsed time and phase come from
   * `turnProgress` — and it sits below the last entry, so it is the thing most likely to
   * be just out of view.
   */
  useEffect(() => {
    if (!pinned.current) return
    settleAtBottom()
  }, [state.entries, state.notices, state.thinkingBlocks, state.turnProgress, settleAtBottom])

  // Hoisted out of the render loop: an inline arrow is a new function every render, so
  // every block's props would differ and `TranscriptBlock`'s memo would never hit.
  const onKeep = useCallback((path?: string) => send({ type: 'reviewKeep', path }), [])
  const onUndo = useCallback((path?: string) => send({ type: 'reviewUndo', path }), [])
  const onDiff = useCallback((path: string) => send({ type: 'openReviewDiff', path }), [])
  const onOpenFile = useCallback((path: string) => send({ type: 'openFile', path }), [])

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
                <TranscriptBlock key={block.id}>
                  <ActivityGroup
                    activity={block.activity}
                    agent={block.agent}
                    agentProvider={block.agentProvider}
                    agentModel={block.agentModel}
                    tools={block.tools}
                    detailed={detailed}
                    toolOverrides={toolOverrides}
                    onToggleTool={onToggleTool}
                    onRequestToolOutput={onRequestToolOutput}
                    onOpenFile={onOpenFile}
                    onOpenDiff={onDiff}
                  />
                </TranscriptBlock>
              ) : (
                <TranscriptBlock key={block.entry.id}>
                  <TranscriptEntryView
                    entry={block.entry}
                    thinking={thinkingByEntry.get(block.entry.id)}
                    detailed={detailed}
                    toolOpen={toolOverrides[block.entry.id]}
                    onToggleTool={onToggleTool}
                    onRequestToolOutput={onRequestToolOutput}
                    turnCompletion={
                      block.entry.kind === 'turn_end'
                        ? state.turnCompletions[block.entry.turnId]
                        : undefined
                    }
                    turnPhase={state.turnProgress?.phase}
                    onKeep={onKeep}
                    onUndo={onUndo}
                    onDiff={onDiff}
                    onOpen={onOpenFile}
                  />
                </TranscriptBlock>
              ),
            )}
            {/*
              The LIVE turn only. A finished turn's completion line is rendered by its
              own `turn_end` marker, in the position the turn ended — which is what lets
              every earlier turn keep its line instead of only the most recent one.
            */}
            {state.turnRunning && state.turnProgress ? (
              <TurnStatus progress={state.turnProgress} />
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
 * The live progress line for the turn in flight.
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
 * `startTimestamp` is read on every render rather than captured once in state. An
 * earlier version captured `Date.now()` in `useState`, which meant the count started
 * when the COMPONENT mounted rather than when the turn began — so a panel opened
 * mid-turn showed a few seconds for a turn that had been running for minutes.
 *
 * ── COMPLETED TURNS ARE NOT RENDERED HERE ──────────────────────────────────────
 *
 * This component used to also draw the completion line, which meant only ONE turn — the
 * one still in `turnProgress` — could ever show it. Completion lines are now anchored by
 * `turn_end` markers in the transcript, so every turn keeps its own. See `TurnEndEntry`.
 *
 * Live: ◌ Thinking… 32s · ↑ 12.8k · ↓ ~1.4k
 */
function TurnStatus({ progress }: { progress: TurnProgressView }): JSX.Element {
  const now = useSecondTick(true)

  const readouts = tokenReadouts(progress.usage)
  const elapsed = Math.max(0, now - progress.startTimestamp)

  return (
    <div className="rc-working" role="status" aria-live="polite">
      {/*
        `spriteStateForPhase` already resolves `waiting` to its own row (the
        character visibly stops and waits) and every working phase to its own —
        one call covers both branches the old static-glyph-vs-spinner split
        needed two glyph systems for.
      */}
      <ProgressGlyph state={spriteStateForPhase(progress.phase)} />
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
