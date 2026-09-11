/**
 * The composer.
 *
 * ── KEYBOARD CONTRACT ──────────────────────────────────────────────────────────
 *
 * Enter sends, Shift+Enter inserts a newline. That is the convention every chat
 * surface uses and the one the design spec specifies, but it has a trap: it makes
 * Enter destructive in a multi-line editor. So the newline path is checked FIRST and
 * the send path only fires on a bare Enter with no modifier — Ctrl, Alt and Meta all
 * fall through, because Ctrl+Enter in particular is muscle memory for "send" in some
 * clients and for "newline" in others, and swallowing it either way would surprise
 * someone.
 *
 * IME composition is excluded via `isComposing`. Without that check, pressing Enter
 * to accept a candidate in a Japanese, Chinese or Korean input method would send a
 * half-typed prompt instead.
 *
 * ── WHY THE HEIGHT IS SET IMPERATIVELY ─────────────────────────────────────────
 *
 * A textarea cannot size itself to its content in CSS. The measured `scrollHeight`
 * is applied on every change, clamped so a pasted file does not push the transcript
 * off screen.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type {
  EffortChoice,
  InferenceSettingsView,
} from '../../shared/inferenceSettings.js'
import type {
  AttachmentView,
  ContextUsageView,
  IdeContextView,
  ModelCatalogueView,
  ModelInfoView,
  ImageInputView,
  PermissionModeView,
  SlashCommandView,
} from '../../shared/webviewProtocol.js'
import { ModelDropdown } from './ModelDropdown.js'
import { InferenceControls } from './InferenceControls.js'
import { PermissionDropdown } from './PermissionDropdown.js'
import {
  formatPathMentions,
  insertAtCursor as insertIntoValue,
  insertedChunk,
  partitionDroppedFiles,
  readImageAttachment,
} from './composerAttachments.js'
import { usePanelDrop } from '../usePanelDrop.js'
import { readPastedPaths } from '../../shared/pastedPaths.js'
import { CloseIcon, PaperclipIcon, SendIcon, StopIcon } from './Icons.js'
import { AttachmentControl } from './AttachmentControl.js'
import { ContextGauge } from './ContextGauge.js'
import {
  AutocompletePopover,
  type AutocompleteItem,
} from './AutocompletePopover.js'
import { TodoListCard, type TodoToolEntry } from './TodoListCard.js'

/** Tallest the input grows before it scrolls internally, in pixels. */
const MAX_HEIGHT = 220

/**
 * Delay before an `@` query reaches the host.
 *
 * Long enough to collapse a burst of typing into one workspace search, short enough that
 * the list feels immediate once the user pauses.
 */
const FILE_SEARCH_DEBOUNCE_MS = 120

export interface ComposerProps {
  /**
   * Seed text, from a prompt chip.
   *
   * Applied as initial state, so the parent remounts this component (via `key`) to
   * change it. That is deliberate: making it a controlled value would mean every
   * keystroke round-tripped through the parent, and a chip is a rare event while
   * typing is not.
   */
  initialValue?: string
  disabled: boolean
  /** Signed-out mode keeps slash authentication available while hiding turn controls. */
  authenticationRequired?: boolean
  turnRunning: boolean
  modelInfo: ModelInfoView
  modelCatalogue: ModelCatalogueView
  inference: InferenceSettingsView
  permissionMode: PermissionModeView
  commands?: SlashCommandView[]
  workspaceFiles?: string[]
  /** The editor's current file and selection, for the context row. */
  ideContext?: IdeContextView | null
  /** Context-window pressure. Lives here, not the header — see ContextGauge. */
  contextUsage?: ContextUsageView | null
  /**
   * Which process executes a prompt: Rayucode itself, or an attached CLI session.
   *
   * In the composer because it changes what SEND does, and that belongs next to the button
   * that does it rather than in a header strip.
   */
  attachment?: AttachmentView
  onListAttachable?: () => void
  onAttachSession?: (pid: number) => void
  onDetachSession?: () => void
  /** Latest TodoWrite state, pinned here until a later call replaces it. */
  todoEntry?: TodoToolEntry | null
  onSubmit: (text: string, images?: ImageInputView[]) => void
  onInterrupt: () => void
  onSelectModel: (value: string) => void
  onRefreshModels: () => void
  onSetEffort: (level: EffortChoice) => void
  onCyclePermissionMode: () => void
  onSelectPermissionMode?: (modeId: string) => void
  onOpenProviderSetup: () => void
  onFindFiles?: (query: string) => void
  /**
   * Turn a `text/uri-list` payload into workspace paths.
   *
   * Asynchronous and host-owned: see `composerAttachments.ts` for why the webview cannot
   * resolve a dropped file's path itself.
   */
  onResolveDroppedPaths?: (uriList: string) => Promise<string[]>
  /** Open the editor's file/folder picker. Resolves empty when cancelled. */
  onPickContextPaths?: () => Promise<string[]>
  /**
   * A drag entered or left the panel.
   *
   * Reported upward rather than drawn here: the handler accepts a drop anywhere in the panel,
   * so the highlight has to cover the panel. Lifting the flag is cheaper than lifting the
   * attachment state and the caret, which is what moving the handler would cost.
   */
  onDragStateChange?: (dragging: boolean) => void
}

export function Composer({
  initialValue = '',
  disabled,
  authenticationRequired = false,
  turnRunning,
  modelInfo,
  modelCatalogue,
  inference,
  permissionMode,
  commands,
  workspaceFiles,
  ideContext,
  contextUsage,
  attachment,
  onListAttachable,
  onAttachSession,
  onDetachSession,
  todoEntry,
  onSubmit,
  onInterrupt,
  onSelectModel,
  onRefreshModels,
  onSetEffort,
  onCyclePermissionMode,
  onSelectPermissionMode,
  onOpenProviderSetup,
  onFindFiles,
  onResolveDroppedPaths,
  onPickContextPaths,
  onDragStateChange,
}: ComposerProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [cursorPos, setCursorPos] = useState(initialValue.length)
  /** Images staged for the next message. Cleared on send, removable individually. */
  const [images, setImages] = useState<ImageInputView[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)

  const updateCursor = useCallback(() => {
    if (textarea.current) {
      setCursorPos(textarea.current.selectionStart)
    }
  }, [])

  // Check if slash command is triggered: starts with '/' and no spaces before cursor
  const isSlashCommand =
    !dismissed &&
    value.startsWith('/') &&
    !value.includes(' ') &&
    cursorPos <= value.length

  const slashQuery = isSlashCommand ? value.slice(1) : ''
  const slashItems: AutocompleteItem[] = useMemo(() => {
    if (!isSlashCommand) return []
    return (commands ?? [])
      .filter(c => c.name.toLowerCase().includes(slashQuery.toLowerCase()))
      .map(c => ({
        id: 'cmd-' + c.name,
        label: '/' + c.name,
        description: c.description,
        insertText: '/' + c.name + ' ',
        kind: 'command',
      }))
  }, [isSlashCommand, commands, slashQuery])

  // Check if @-mention is triggered: '@' anywhere preceded by start of line or whitespace
  const textBeforeCursor = value.slice(0, cursorPos)
  const mentionMatch = /(?:^|\s)@([^\s]*)$/.exec(textBeforeCursor)
  const isMention = !dismissed && !isSlashCommand && mentionMatch !== null
  const fileQuery = isMention ? mentionMatch[1] : ''

  // Debounced: `findFiles` runs a workspace glob in the extension host, and firing it on
  // every keystroke of `@src/comp…` queues one search per character — each one wider than
  // the last, so the slowest lands last and can overwrite a newer, narrower result.
  useEffect(() => {
    if (!isMention) return
    const id = setTimeout(() => onFindFiles?.(fileQuery), FILE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [isMention, fileQuery, onFindFiles])

  const fileItems: AutocompleteItem[] = useMemo(() => {
    if (!isMention) return []
    const q = fileQuery.toLowerCase()
    return (workspaceFiles ?? [])
      .filter(f => f.toLowerCase().includes(q))
      .slice(0, 20)
      .map(f => ({
        id: 'file-' + f,
        label: f,
        description: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : undefined,
        insertText: '@' + f + ' ',
        // The host appends a trailing slash to directories it derived from file results,
        // which is the only signal distinguishing the two — a folder and an extensionless
        // file are otherwise identical strings.
        kind: f.endsWith('/') ? 'folder' : 'file',
      }))
  }, [isMention, workspaceFiles, fileQuery])

  const popoverItems = isSlashCommand ? slashItems : isMention ? fileItems : []

  useEffect(() => {
    setSelectedIndex(0)
  }, [popoverItems.length])

  const applySelection = useCallback(
    (item: AutocompleteItem) => {
      if (item.kind === 'command') {
        setValue(item.insertText)
        setDismissed(true)
        setTimeout(() => {
          if (textarea.current) {
            textarea.current.focus()
            textarea.current.setSelectionRange(
              item.insertText.length,
              item.insertText.length,
            )
          }
        }, 0)
      } else {
        const tokenStart = cursorPos - fileQuery.length - 1
        const before = value.slice(0, tokenStart)
        const after = value.slice(cursorPos)
        const nextValue = before + item.insertText + after
        setValue(nextValue)
        setDismissed(true)
        const newCursor = tokenStart + item.insertText.length
        setCursorPos(newCursor)
        setTimeout(() => {
          if (textarea.current) {
            textarea.current.focus()
            textarea.current.setSelectionRange(newCursor, newCursor)
          }
        }, 0)
      }
    },
    [cursorPos, fileQuery, value],
  )

  // useLayoutEffect, not useEffect: resizing after paint makes the box visibly jump
  // as the user types.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  // When a turn ends the composer becomes usable again; putting the cursor back
  // saves a click before the follow-up prompt, which is the common case.
  useEffect(() => {
    if (!turnRunning && !disabled) textarea.current?.focus()
  }, [turnRunning, disabled])

  const submit = useCallback(() => {
    const text = value.trim()
    // An image with no words is a legitimate prompt — "what is this?" is implied.
    if ((!text && images.length === 0) || disabled) return
    onSubmit(text, images)
    setValue('')
    setImages([])
    setAttachError(null)
  }, [value, images, disabled, onSubmit])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Autocomplete navigation intercepts Arrow keys, Enter and Escape
      if (popoverItems.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelectedIndex(prev => (prev + 1) % popoverItems.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedIndex(
            prev => (prev - 1 + popoverItems.length) % popoverItems.length,
          )
          return
        }
        if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
          if (
            !event.nativeEvent.isComposing &&
            !event.shiftKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.metaKey
          ) {
            event.preventDefault()
            event.stopPropagation()
            const selected = popoverItems[selectedIndex]
            if (selected) {
              applySelection(selected)
            }
            return
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setDismissed(true)
          return
        }
      }

      // Shift+Tab cycles permission mode. Checked before the Enter handling so the
      // two shortcuts cannot interfere, and `preventDefault` is required or the
      // browser moves focus out of the textarea instead.
      if (
        !authenticationRequired &&
        event.key === 'Tab' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault()
        onCyclePermissionMode()
        return
      }

      if (event.key !== 'Enter') return
      // Mid-composition Enter belongs to the input method, not to us.
      if (event.nativeEvent.isComposing) return
      // Newline path first, so the destructive path is the narrower one.
      if (event.shiftKey) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      event.preventDefault()
      submit()
    },
    [
      submit,
      onCyclePermissionMode,
      authenticationRequired,
      popoverItems,
      selectedIndex,
      applySelection,
    ],
  )

  // ── Attachments: paste and the context picker ──────────────────────────────
  //
  // Drag and drop is handled PANEL-WIDE by `usePanelDrop`, not here: a file dragged from the
  // Explorer lands on the conversation far more often than on this strip, and handlers scoped
  // to the card silently discarded those drops. See that hook for why the listeners are on
  // `document` and why `dragover` must be prevented.

  /** Insert text at the caret, padded so it cannot run into adjacent words. */
  const insertText = useCallback(
    (text: string) => {
      if (!text) return
      setValue(current => {
        const next = insertIntoValue(current, cursorPos, text)
        setCursorPos(next.cursor)
        // Focus and caret are restored after paint: the value has not been committed to the
        // DOM node yet at this point, so setting the range now would clamp to the old length.
        setTimeout(() => {
          textarea.current?.focus()
          textarea.current?.setSelectionRange(next.cursor, next.cursor)
        }, 0)
        return next.value
      })
    },
    [cursorPos],
  )

  /** Stage image files, reporting the first one that could not be read. */
  const attachImages = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    try {
      const attachments = await Promise.all(files.map(readImageAttachment))
      setAttachError(null)
      setImages(current => [...current, ...attachments])
    } catch (cause) {
      // Reported inline rather than thrown away: a dropped image that silently fails to
      // attach looks like the panel ignoring the user.
      setAttachError(cause instanceof Error ? cause.message : 'That image could not be attached.')
    }
  }, [])

  const insertResolvedPaths = useCallback(
    async (uriList: string) => {
      if (!onResolveDroppedPaths) return
      const paths = await onResolveDroppedPaths(uriList)
      insertText(formatPathMentions(paths))
    },
    [onResolveDroppedPaths, insertText],
  )

  // Panel-wide drop. The listeners live on `document` (see usePanelDrop) so a file dragged
  // from an editor tab is accepted anywhere in the panel, not only over this strip — which is
  // where the previous card-scoped handlers silently lost most drops. The logic stays here
  // because this component owns the staged images and the caret; the OVERLAY is drawn by the
  // shell, because a drop target that only highlights the composer contradicts a handler that
  // accepts the whole panel.
  const isDragging = usePanelDrop({
    onPaths: uriList => void insertResolvedPaths(uriList),
    onImages: files => void attachImages(files),
    onText: text => {
      // A dropped selection is usually prose, but it can equally be a path — some sources offer
      // nothing but `text/plain`. Same rule as the terminal: if it resolves to a file, attach it;
      // otherwise insert it verbatim.
      const paths = readPastedPaths(text)
      if (paths) {
        void insertResolvedPaths(paths.join('\n'))
        return
      }
      insertText(text)
    },
    onUnusable: names =>
      setAttachError(
        `${names[0] ? `“${names[0]}”` : 'That file'} was dropped without a path, so it cannot be attached. Use Add Context, or type @ to reference a workspace file.`,
      ),
    // VS Code took the drag before it landed. Stated plainly, with the two things that DO work,
    // because the alternative is a drop target that lights up and then silently does nothing.
    onIntercepted: () =>
      setAttachError(
        'VS Code intercepted that drag before it reached Rayucode. Hold Shift while dragging, or use Add Context / @ instead.',
      ),
  })

  useEffect(() => {
    onDragStateChange?.(isDragging)
  }, [isDragging, onDragStateChange])

  /**
   * Turn a path that landed in the input as TEXT into an attachment.
   *
   * ── WHY THIS EXISTS AS WELL AS THE DROP AND PASTE HANDLERS ───────────────────
   *
   * A dropped file frequently never reaches a drop handler at all. Chromium's default action for
   * a drop onto a `<textarea>` is to insert the dragged text at the caret, so the file arrives as
   * a bare path in the input — which is precisely what happens in a terminal, where the emulator
   * pastes the path and the CLI recovers the file from it. Catching it here makes the editor
   * behave like the terminal for the same gesture, and it also picks up middle-click paste and
   * anything else that bypasses the `paste` event.
   *
   * ── TWO GUARDS, BOTH LOAD-BEARING ────────────────────────────────────────────
   *
   * 1. THE INSERTION MUST BE MORE THAN ONE CHARACTER. Typing arrives one character at a time, and
   *    `/` on its own parses as an absolute path — without this, typing a slash would fire this.
   * 2. THE TEXT IS ONLY REPLACED IF THE HOST RESOLVED SOMETHING. `readPastedPaths` recognises a
   *    shape, not a file that exists; substituting on the strength of the shape alone would
   *    delete what the user typed whenever the path was wrong. The host stats every candidate, so
   *    an empty answer means "not a file" and the text is left exactly as it was.
   *
   * The replacement is located by SEARCHING for the inserted text rather than by the index it was
   * inserted at, because the user can keep typing during the round-trip and an index goes stale.
   */
  const convertDroppedPathText = useCallback(
    (before: string, after: string) => {
      if (!onResolveDroppedPaths) return
      const inserted = insertedChunk(before, after)
      if (!inserted || inserted.text.trim().length < 2) return
      const paths = readPastedPaths(inserted.text)
      if (!paths) return

      void (async () => {
        const resolved = await onResolveDroppedPaths(paths.join('\n'))
        if (resolved.length === 0) return
        const mentions = formatPathMentions(resolved)
        if (!mentions) return
        setValue(current => {
          const at = current.indexOf(inserted.text)
          if (at === -1) return current
          const next =
            current.slice(0, at) + mentions + current.slice(at + inserted.text.length)
          const caret = at + mentions.length
          setCursorPos(caret)
          // After paint, for the same reason `insertText` defers: the DOM node still holds the
          // previous value at this point, so a range set now would be clamped to its length.
          setTimeout(() => {
            textarea.current?.focus()
            textarea.current?.setSelectionRange(caret, caret)
          }, 0)
          return next
        })
      })()
    },
    [onResolveDroppedPaths],
  )

  /**
   * Pasted content: a screenshot, or the path of a file copied in a file manager.
   *
   * ── THE PATH CASE IS HOW THE CLI'S "DRAG AND DROP" WORKS ─────────────────────
   *
   * Dragging a file onto a terminal produces no drop event — the terminal PASTES the path, and
   * `hooks/usePasteHandler.ts` recovers the files from that text. This is the same handling, so
   * copying a file and pressing Ctrl+V here attaches it exactly as dragging it into the terminal
   * does, using the same parsing rules (`shared/pastedPaths.ts`): space-separated absolute
   * paths, escaped spaces, quoted paths.
   *
   * It also gives a gesture that VS Code cannot intercept. A drag can be taken away from a
   * webview before it arrives; a paste cannot.
   */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      const { images: imageFiles } = partitionDroppedFiles(files)
      if (imageFiles.length > 0) {
        // Only prevented when there IS an image: otherwise this would swallow ordinary text
        // pastes, which must keep the browser's own behaviour.
        event.preventDefault()
        void attachImages(imageFiles)
        return
      }

      // `readPastedPaths` returns null for prose, which is the common case and must fall through
      // to the browser's own paste untouched.
      const paths = readPastedPaths(event.clipboardData?.getData('text/plain') ?? '')
      if (!paths) return
      event.preventDefault()
      void insertResolvedPaths(paths.join('\n'))
    },
    [attachImages, insertResolvedPaths],
  )

  const addContext = useCallback(async () => {
    if (!onPickContextPaths) return
    insertText(formatPathMentions(await onPickContextPaths()))
  }, [onPickContextPaths, insertText])

  /**
   * Insert the editor's selection as an explicit `@path#Lstart-end` mention.
   *
   * The engine ALREADY attaches the selection to every message on its own, so this is not
   * how the model learns about it — it is how the user pins a specific range into the words
   * of the prompt ("refactor @src/a.ts#L10-20 to use X"), which survives them clicking
   * elsewhere before sending. The format is the CLI's, character for character.
   */
  const addSelectionMention = useCallback(() => {
    const path = ideContext?.relativePath
    if (!path) return
    const { lineStart, lineEnd } = ideContext
    const range =
      lineStart === undefined
        ? ''
        : lineEnd === undefined || lineEnd === lineStart
          ? `#L${lineStart}`
          : `#L${lineStart}-${lineEnd}`
    insertText(`@${path}${range}`)
  }, [ideContext, insertText])

  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled

  return (
    <div
      className={`rc-composer-card${isDragging ? ' rc-composer-drag-over' : ''}`}
    >
      {/* Context row: what the editor is pointing at, and what a send would attach. */}
      <IdeContextRow context={ideContext ?? null} onAdd={addSelectionMention} />

      {todoEntry ? <TodoListCard entry={todoEntry} embedded /> : null}

      {images.length > 0 ? (
        <ul className="rc-attach-strip" aria-label="Attached images">
          {images.map((image, index) => (
            <li key={`${image.name ?? 'image'}-${index}`} className="rc-attach-chip">
              {/*
                Rendered from the same base64 that will be sent, so the preview cannot
                disagree with the attachment. The CSP allows `data:` images for this.
              */}
              <img
                className="rc-attach-thumb"
                src={`data:${image.mediaType};base64,${image.data}`}
                alt=""
              />
              <span className="rc-attach-name">{image.name ?? 'image'}</span>
              <button
                type="button"
                className="rc-attach-remove"
                onClick={() => setImages(current => current.filter((_, i) => i !== index))}
                title="Remove image"
                aria-label={`Remove ${image.name ?? 'image'}`}
              >
                <CloseIcon size={10} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachError ? (
        <p className="rc-attach-error" role="alert">
          {attachError}
        </p>
      ) : null}

      <AutocompletePopover
        items={popoverItems}
        selectedIndex={selectedIndex}
        onSelect={applySelection}
        onHoverIndex={setSelectedIndex}
      />

      <textarea
        ref={textarea}
        className="rc-composer-input"
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={
          disabled
            ? 'Sign in to send a message'
            : authenticationRequired
              ? 'Type /login or /connect to sign in…'
              : 'Ask Rayu to build or change something…'
        }
        aria-label="Message Rayu"
        onChange={event => {
          const next = event.target.value
          // `value` is still the PREVIOUS value here, which is what the comparison needs.
          convertDroppedPathText(value, next)
          setValue(next)
          setDismissed(false)
          setCursorPos(event.target.selectionStart)
        }}
        onClick={updateCursor}
        onKeyUp={updateCursor}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />

      <div className="rc-composer-toolbar">
        {!authenticationRequired ? (
          <div className="rc-composer-pills">
            {onPickContextPaths ? (
              <button
                type="button"
                className="rc-pill rc-pill-button rc-pill-add-context"
                onClick={() => void addContext()}
                title={
                  'Add files or folders as context.\n' +
                  'You can also drag them straight onto this panel.'
                }
                aria-label="Add context"
              >
                <PaperclipIcon size={12} />
                <span className="rc-pill-label">Add Context</span>
              </button>
            ) : null}

            {attachment && onListAttachable && onAttachSession && onDetachSession ? (
              <AttachmentControl
                attachment={attachment}
                onList={onListAttachable}
                onAttach={onAttachSession}
                onDetach={onDetachSession}
              />
            ) : null}

            <PermissionDropdown
              mode={permissionMode}
              onSelect={onSelectPermissionMode ?? onCyclePermissionMode}
              onCycle={onCyclePermissionMode}
            />

            <ModelDropdown
              current={modelInfo.model}
              catalogue={modelCatalogue}
              onSelect={onSelectModel}
              onRefresh={onRefreshModels}
            />

            <InferenceControls
              settings={inference}
              onSetEffort={onSetEffort}
            />
          </div>
        ) : null}

        <span className="rc-composer-spacer" />

        {contextUsage ? <ContextGauge usage={contextUsage} /> : null}

        {turnRunning ? (
          <button
            type="button"
            className="rc-submit rc-submit-stop"
            onClick={onInterrupt}
            aria-label="Stop generating"
            title="Stop generating"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            className="rc-submit"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send message"
            title="Send (Enter)"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}





/**
 * What the editor is currently pointing at.
 *
 * ── THIS IS DISCLOSURE, NOT A CONTROL ──────────────────────────────────────────
 *
 * The engine attaches the selection to the next message by itself, through the same shared
 * attachment path the CLI uses. Without this row that happens INVISIBLY, and an answer that
 * suddenly discusses code the user had forgotten was highlighted is indistinguishable from
 * the model hallucinating context. So the row states what will be sent.
 *
 * The wording matches the CLI's own indicator — `⧉ N lines selected`, else `⧉ In <file>` —
 * so the two surfaces describe the same editor the same way.
 */
function IdeContextRow({
  context,
  onAdd,
}: {
  context: IdeContextView | null
  onAdd: () => void
}): JSX.Element | null {
  // Nothing open means nothing to disclose. Rendering an empty row would imply the editor
  // connection is broken, when the common cause is simply no active editor.
  if (!context || !context.relativePath) return null

  const selected = context.lineCount > 0
  const label = selected
    ? `${context.lineCount} ${context.lineCount === 1 ? 'line' : 'lines'} selected`
    : `In ${context.relativePath.split('/').pop() ?? context.relativePath}`

  return (
    <div className="rc-ide-context">
      <span className="rc-ide-context-glyph" aria-hidden="true">
        ⧉
      </span>
      <span className="rc-ide-context-label" title={context.relativePath}>
        {label}
      </span>
      {/* Offered only for a real selection: pinning a whole file is what typing `@file`
          already does, and a button that duplicates the autocomplete adds noise. */}
      {selected ? (
        <button
          type="button"
          className="rc-ide-context-add"
          onClick={onAdd}
          title="Insert this selection as an @-mention"
        >
          Add to prompt
        </button>
      ) : null}
    </div>
  )
}
