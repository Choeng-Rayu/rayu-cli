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
  partitionDroppedFiles,
  readImageAttachment,
} from './composerAttachments.js'
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
}: ComposerProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [cursorPos, setCursorPos] = useState(initialValue.length)
  const [isDragging, setIsDragging] = useState(false)
  /** Images staged for the next message. Cleared on send, removable individually. */
  const [images, setImages] = useState<ImageInputView[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const dragDepth = useRef(0)

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

  // ── Attachments: drag/drop, paste, and the context picker ──────────────────
  //
  // Drag depth is tracked as a COUNTER, not a boolean: `dragenter`/`dragleave` bubble from
  // every child element, so a naive toggle flickers the overlay each time the pointer
  // crosses an internal boundary.
  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current++
    setIsDragging(true)
  }, [])

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    // Tell the browser we accept the drop so the cursor reflects that.
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current--
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setIsDragging(false)
    }
  }, [])

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

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setIsDragging(false)

      const dt = event.dataTransfer

      // Images are embedded; everything else is REFERENCED by path. Reading a source file
      // into the prompt would duplicate what the engine's own @-mention expansion does,
      // and would do it worse (no line numbers, no truncation policy, no permissions).
      const { images: imageFiles } = partitionDroppedFiles(Array.from(dt.files ?? []))
      if (imageFiles.length > 0) void attachImages(imageFiles)

      // `text/uri-list` is what VS Code populates for an Explorer drag, and the only
      // reliable source of a real path — see composerAttachments.ts.
      const uriList = dt.getData('text/uri-list')
      if (uriList.trim()) {
        void insertResolvedPaths(uriList)
        return
      }

      // Nothing but images was dropped; the chips are the feedback.
      if (imageFiles.length > 0) return

      // A selection dragged out of an editor arrives as plain text.
      const text = dt.getData('text')
      if (text) insertText(text)
    },
    [attachImages, insertResolvedPaths, insertText],
  )

  /** Pasted screenshots are the common way an image reaches a chat composer. */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.files ?? [])
      const { images: imageFiles } = partitionDroppedFiles(files)
      if (imageFiles.length === 0) return
      // Only prevented when there IS an image: otherwise this would swallow ordinary text
      // pastes, which must keep the browser's own behaviour.
      event.preventDefault()
      void attachImages(imageFiles)
    },
    [attachImages],
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
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragging ? (
        <div className="rc-composer-drop-overlay" aria-hidden="true">
          <span className="rc-composer-drop-icon">@</span>
          <span className="rc-composer-drop-text">
            Drop files, folders or images
          </span>
        </div>
      ) : null}

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
          setValue(event.target.value)
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
                title="Add files or folders as context"
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
