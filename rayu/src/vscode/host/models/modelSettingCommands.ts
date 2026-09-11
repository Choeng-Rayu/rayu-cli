/**
 * `/model_subagent` and `/webfetch_model`, as Rayucode implements them.
 *
 * ── WHY THE HOST OWNS THESE AT ALL ─────────────────────────────────────────────
 *
 * Both are `local-jsx` commands in the CLI — they render an Ink picker — so `main.tsx`
 * removes them from a non-interactive engine, exactly as it removes `/login` and
 * `/connect`. The engine would answer "unknown command", so the panel has to provide the
 * surface. What it must NOT provide is a second definition of the settings: the parsing
 * below mirrors the CLI's grammar and the writes go through the CLI's own `rayuConfig`
 * setters, so there is one place each value lives.
 *
 * ── PARSING IS SPLIT FROM APPLYING, AND IS PURE ────────────────────────────────
 *
 * `parseModelSettingCommand` is a pure function over the typed text. That matters because
 * the one thing that must not break here is the fall-through: a prompt that merely begins
 * with `/model_subagent…` and is not one of these commands has to reach the model unchanged.
 * A pure parser is exhaustively testable without an editor, a config file or an engine.
 */
import {
  clearSubagentSelection,
  getSubagentSelection,
  getWebFetchModelSelection,
  setSubagentSelection,
  setWebFetchModelSelection,
} from '../../../utils/rayuConfig.js'
import type { ModelChooserView } from '../../shared/webviewProtocol.js'

/** The CLI's own reset and inspect keywords, matched case-insensitively as it does. */
const RESET_WORDS = new Set(['default', 'reset', 'clear'])
const SHOW_WORDS = new Set(['info', 'show', 'status'])

/**
 * What `/webfetch_model` falls back to when unset.
 *
 * Worded as the CLI words it. Saying only "default" would leave the user unable to tell
 * which model they are actually getting.
 */
const WEBFETCH_DEFAULT_NOTE =
  "the active provider\u2019s instant/small-fast model (i.e. your current model)"

const SUBAGENT_GLOBAL_DEFAULT_NOTE =
  "the main provider\u2019s instant/small-fast model"

const SUBAGENT_AGENT_DEFAULT_NOTE =
  'the global subagent model, else the main provider\u2019s instant model'

const SUBAGENT_COST_TIP =
  'Subagents run frequently — a large model here costs more and is usually overkill for small subtasks.'

const WEBFETCH_COST_TIP =
  'WebFetch summarizes fetched pages — a small/instant model is usually enough and cheaper.'

export type ModelSettingTarget = 'subagent' | 'webfetch'

/** What the user asked for. `choose` is the picker; the rest answer immediately. */
export type ModelSettingCommand =
  | { kind: 'choose'; target: ModelSettingTarget; agentType?: string }
  | { kind: 'reset'; target: ModelSettingTarget; agentType?: string }
  | { kind: 'show'; target: ModelSettingTarget; agentType?: string }
  /** A recognised command with an argument that is not valid — answered with usage. */
  | { kind: 'usage'; target: ModelSettingTarget; message: string }

/**
 * Recognise one of these commands in typed text.
 *
 * Returns null for anything else, INCLUDING a prompt that merely starts with the command
 * name as part of a sentence. The command name must be the first whitespace-delimited
 * token, which is what the CLI's own dispatcher requires.
 *
 * `knownAgentTypes` comes from the engine rather than being imported, so the list cannot
 * drift from what the running engine actually offers — and so the host bundle does not have
 * to carry every subagent's prompt module to know their names.
 */
export function parseModelSettingCommand(
  text: string,
  knownAgentTypes: readonly string[] = [],
): ModelSettingCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const [rawName, ...rest] = trimmed.split(/\s+/)
  const name = rawName?.slice(1).toLowerCase()

  const target: ModelSettingTarget | null =
    name === 'model_subagent' ? 'subagent' : name === 'webfetch_model' ? 'webfetch' : null
  if (!target) return null

  if (target === 'webfetch') {
    const sub = (rest[0] ?? '').toLowerCase()
    if (!sub) return { kind: 'choose', target }
    if (RESET_WORDS.has(sub)) return { kind: 'reset', target }
    if (SHOW_WORDS.has(sub)) return { kind: 'show', target }
    return {
      kind: 'usage',
      target,
      message: `Unknown argument "${sub}". Usage: /webfetch_model [show|default].`,
    }
  }

  // `/model_subagent [AGENT] [show|default]` — the first token may be an agent type,
  // resolved case-insensitively exactly as the CLI resolves it.
  const first = rest[0] ?? ''
  const agentType = knownAgentTypes.find(a => a.toLowerCase() === first.toLowerCase())
  const sub = (agentType ? rest[1] ?? '' : first).toLowerCase()

  if (!sub) return { kind: 'choose', target, ...(agentType ? { agentType } : {}) }
  if (RESET_WORDS.has(sub)) return { kind: 'reset', target, ...(agentType ? { agentType } : {}) }
  if (SHOW_WORDS.has(sub)) return { kind: 'show', target, ...(agentType ? { agentType } : {}) }

  return {
    kind: 'usage',
    target,
    message:
      `Unknown argument "${sub}". Usage: /model_subagent [AGENT] [show|default].` +
      (knownAgentTypes.length > 0 ? ` Subagents: ${knownAgentTypes.join(', ')}.` : ''),
  }
}

/** The label for what is configured now, or null when the default applies. */
export function currentSelectionLabel(
  target: ModelSettingTarget,
  agentType?: string,
): string | null {
  if (target === 'webfetch') return getWebFetchModelSelection() ?? null
  const selection = getSubagentSelection(agentType)
  return selection ? `${selection.model} (${selection.providerId})` : null
}

/** The model identifier to mark as active in the picker, or null. */
export function currentSelectionValue(
  target: ModelSettingTarget,
  agentType?: string,
): string | null {
  if (target === 'webfetch') return getWebFetchModelSelection() ?? null
  return getSubagentSelection(agentType)?.model ?? null
}

export function defaultNoteFor(
  target: ModelSettingTarget,
  agentType?: string,
): string {
  if (target === 'webfetch') return WEBFETCH_DEFAULT_NOTE
  return agentType ? SUBAGENT_AGENT_DEFAULT_NOTE : SUBAGENT_GLOBAL_DEFAULT_NOTE
}

/** The chooser surface for a bare command. */
export function buildChooser(
  target: ModelSettingTarget,
  agentType?: string,
): ModelChooserView {
  return {
    target,
    ...(agentType ? { agentType } : {}),
    title:
      target === 'webfetch'
        ? 'Select a model for WebFetch (page summarization)'
        : agentType
          ? `Select a model for ${agentType}`
          : 'Select a model for subagents (global default)',
    tip: target === 'webfetch' ? WEBFETCH_COST_TIP : SUBAGENT_COST_TIP,
    current: currentSelectionValue(target, agentType),
    defaultNote: defaultNoteFor(target, agentType),
  }
}

/** The `show` answer, worded as the CLI words it. */
export function describeSelection(
  target: ModelSettingTarget,
  agentType?: string,
): string {
  const label = currentSelectionLabel(target, agentType)
  if (target === 'webfetch') {
    return label
      ? `WebFetch model: ${label}`
      : `WebFetch model: default (${WEBFETCH_DEFAULT_NOTE})`
  }
  const subject = agentType ? `${agentType} subagent` : 'subagent'
  return label
    ? `${subject} model: ${label}`
    : `${subject} model: default (${defaultNoteFor(target, agentType)})`
}

/** The confirmation for a reset, worded as the CLI words it. */
export function describeReset(
  target: ModelSettingTarget,
  agentType?: string,
): string {
  if (target === 'webfetch') {
    return `WebFetch model reset to default (${WEBFETCH_DEFAULT_NOTE}).`
  }
  return agentType
    ? `${agentType} model reset to default (uses ${SUBAGENT_AGENT_DEFAULT_NOTE}).`
    : `Global subagent model reset to default (${SUBAGENT_GLOBAL_DEFAULT_NOTE}).`
}

/**
 * Persist a choice.
 *
 * Returns the confirmation to show, or null when nothing was written — a `value` that
 * carries no model is not an error worth a notice, it is a no-op.
 *
 * ── THE PROVIDER PREFIX IS DECODED, NOT STORED ─────────────────────────────────
 *
 * The webview sends the catalogue's `value`, which for a configured provider is the shared
 * `providerId\0model` routing form. `setSubagentSelection` wants the two parts separately,
 * because a subagent may legitimately run on a different provider from the main agent.
 * Splitting on the same NUL the CLI's own encoder uses keeps that one convention.
 */
export function applySelection(
  target: ModelSettingTarget,
  value: string | null,
  agentType?: string,
): string | null {
  if (value === null) {
    if (target === 'webfetch') setWebFetchModelSelection(undefined)
    else clearSubagentSelection(agentType)
    return describeReset(target, agentType)
  }

  const separator = value.indexOf('\u0000')
  const providerId = separator === -1 ? undefined : value.slice(0, separator)
  const model = separator === -1 ? value : value.slice(separator + 1)
  if (!model) return null

  if (target === 'webfetch') {
    // Stored WITHOUT the provider prefix, matching the CLI command: `getWebFetchModel()`
    // resolves it against the active provider.
    setWebFetchModelSelection(model)
    return `WebFetch model: ${model}`
  }

  if (!providerId) {
    // No provider prefix means the catalogue entry did not carry one, and a subagent
    // selection is meaningless without it — it is half a routing decision.
    return null
  }
  setSubagentSelection(providerId, model, agentType)
  const subject = agentType ? `${agentType} subagent` : 'subagent'
  return `${subject} model: ${model} (${providerId})`
}
