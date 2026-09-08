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
  ModelCatalogueView,
  ModelInfoView,
  PermissionModeView,
  SlashCommandView,
} from '../../shared/webviewProtocol.js'
import { ModelDropdown } from './ModelDropdown.js'
import { InferenceControls } from './InferenceControls.js'
import {
  AutocompletePopover,
  type AutocompleteItem,
} from './AutocompletePopover.js'

/** Tallest the input grows before it scrolls internally, in pixels. */
const MAX_HEIGHT = 220

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
  turnRunning: boolean
  modelInfo: ModelInfoView
  modelCatalogue: ModelCatalogueView
  inference: InferenceSettingsView
  permissionMode: PermissionModeView
  commands?: SlashCommandView[]
  workspaceFiles?: string[]
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onSelectModel: (value: string) => void
  onRefreshModels: () => void
  onSetEffort: (level: EffortChoice) => void
  onSetThinking: (enabled: boolean) => void
  onCyclePermissionMode: () => void
  onOpenProviderSetup: () => void
  onFindFiles?: (query: string) => void
}

export function Composer({
  initialValue = '',
  disabled,
  turnRunning,
  modelInfo,
  modelCatalogue,
  inference,
  permissionMode,
  commands,
  workspaceFiles,
  onSubmit,
  onInterrupt,
  onSelectModel,
  onRefreshModels,
  onSetEffort,
  onSetThinking,
  onCyclePermissionMode,
  onOpenProviderSetup,
  onFindFiles,
}: ComposerProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [cursorPos, setCursorPos] = useState(initialValue.length)
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

  useEffect(() => {
    if (isMention) {
      onFindFiles?.(fileQuery)
    }
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
        kind: 'file',
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
    if (!text || disabled) return
    onSubmit(text)
    setValue('')
  }, [value, disabled, onSubmit])

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
      if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey) {
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
    [submit, onCyclePermissionMode, popoverItems, selectedIndex, applySelection],
  )

  const canSend = value.trim().length > 0 && !disabled

  return (
    <div className="rc-composer-card">
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
          disabled ? 'Sign in to send a message' : 'Ask Rayu to build or change something…'
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
      />

      <div className="rc-composer-toolbar">
        <button
          type="button"
          className="rc-pill rc-pill-button"
          onClick={onCyclePermissionMode}
          title={`${permissionMode.description}  (Shift+Tab to cycle)`}
          aria-label={`Permission mode: ${permissionMode.label}. Shift+Tab to change.`}
        >
          <ShieldIcon />
          {permissionMode.label}
        </button>

        <ModelDropdown
          current={modelInfo.model}
          catalogue={modelCatalogue}
          onSelect={onSelectModel}
          onRefresh={onRefreshModels}
        />

        <InferenceControls
          settings={inference}
          onSetEffort={onSetEffort}
          onSetThinking={onSetThinking}
        />

        {modelInfo.provider ? (
          <button
            type="button"
            className="rc-pill rc-pill-muted rc-pill-button"
            onClick={onOpenProviderSetup}
            title="Provider settings"
          >
            {modelInfo.provider}
          </button>
        ) : null}

        <span className="rc-composer-spacer" />

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

function ShieldIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" role="presentation">
      <path d="M8 1.5l5 2v4c0 3-2.1 5.6-5 6.9-2.9-1.3-5-3.9-5-6.9v-4l5-2z" />
    </svg>
  )
}

function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" role="presentation">
      <path d="M8 2.5l5 5H9.25v6h-2.5v-6H3l5-5z" />
    </svg>
  )
}

function StopIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" role="presentation">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}
