// Build a Kiro (CodeWhisperer) request payload from Anthropic Messages params.
// Ports kirocc-fork/internal/reqconv/* (build_payload, message_normalizer,
// tool_convert, schema_sanitize, history, tool_results, content_*, images,
// tool_name_map) + kiroproto/types.go.
import { createHash } from 'node:crypto'
import { resolveKiroModel } from './kiroModels.js'

type AnyObj = Record<string, unknown>

export type KiroBetaParams = {
  model: string
  max_tokens?: number
  system?: string | Array<{ type?: string; text?: string }>
  messages: Array<AnyObj>
  tools?: Array<AnyObj>
  tool_choice?: AnyObj
  thinking?: { type?: string; budget_tokens?: number }
}

// --- Kiro payload types (kiroproto/types.go) --------------------------------
export type KiroToolEntry = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: Record<string, unknown> }
  }
}
export type KiroToolResult = {
  toolUseId: string
  status: 'success' | 'error'
  content: Array<{ json: Record<string, unknown> }>
}
export type KiroImage = { format: string; source: { bytes: string } }
export type KiroUserInputMessageContext = {
  tools?: KiroToolEntry[]
  toolResults?: KiroToolResult[]
}
export type KiroUserInputMessage = {
  content: string
  modelId?: string
  origin?: string
  userInputMessageContext?: KiroUserInputMessageContext
  images?: KiroImage[]
}
export type KiroHistoryToolUse = { toolUseId: string; name: string; input: unknown }
export type KiroHistoryEntry =
  | {
      userInputMessage: {
        content: string
        origin?: string
        userInputMessageContext?: KiroUserInputMessageContext
      }
    }
  | {
      assistantResponseMessage: {
        messageId?: string
        content: string
        toolUses?: KiroHistoryToolUse[]
      }
    }
export type KiroPayload = {
  conversationState: {
    conversationId?: string
    chatTriggerType: string
    agentTaskType: string
    currentMessage: { userInputMessage: KiroUserInputMessage }
    history?: KiroHistoryEntry[]
  }
  profileArn?: string
}

const ORIGIN = 'KIRO_CLI'
const CHAT_TRIGGER_MANUAL = 'MANUAL'
const AGENT_TASK_VIBE = 'vibe'
const SYNTHETIC_EMPTY = '(empty)'
const SYNTHETIC_CONTINUE = 'Continue'
const DEFAULT_THINKING_BUDGET = 10000 // ThinkingBudgetMedium

// Synthetic assistant ack kiro-cli always inserts after the system prompt.
const SYNTHETIC_ACK =
  'I will fully incorporate this information when generating my responses, and explicitly acknowledge relevant parts of the summary when answering questions.'

// --- uuid v5 (deterministic, RFC 4122) --------------------------------------
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
function uuidV5(name: string, namespace = URL_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const b = hash.subarray(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
const SYNTHETIC_ACK_MESSAGE_ID = uuidV5(`synthetic-ack:${SYNTHETIC_ACK}`)

// --- Tool name map (>64 chars shortened, reversible) ------------------------
const MAX_TOOL_NAME_LEN = 64
export class ToolNameMap {
  private toShort = new Map<string, string>()
  private toOriginal = new Map<string, string>()
  shorten(name: string): string {
    if (name.length <= MAX_TOOL_NAME_LEN) return name
    const existing = this.toShort.get(name)
    if (existing) return existing
    const h = createHash('sha256').update(name).digest('hex')
    const short = `${name.slice(0, 50)}_${h.slice(0, 13)}`
    this.toShort.set(name, short)
    this.toOriginal.set(short, name)
    return short
  }
  restore(name: string): string {
    return this.toOriginal.get(name) ?? name
  }
}

// --- content accessors (raw Anthropic block objects) ------------------------
function isStringContent(content: unknown): content is string {
  return typeof content === 'string'
}
function blocksOf(content: unknown): AnyObj[] {
  return Array.isArray(content) ? (content as AnyObj[]) : []
}

/** Plain text of a message's content (text blocks joined with space). */
function extractText(content: unknown): string {
  if (isStringContent(content)) return content
  const parts: string[] = []
  for (const b of blocksOf(content)) {
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (
      b.type === 'thinking' ||
      b.type === 'redacted_thinking' ||
      b.type === 'tool_use' ||
      b.type === 'server_tool_use' ||
      b.type === 'tool_result' ||
      b.type === 'image'
    ) {
      // handled elsewhere / skipped
    } else {
      const id = (b.name as string) || (b.id as string) || ''
      parts.push(id ? `[${b.type}: ${id}]` : `[${b.type}]`)
    }
  }
  return parts.join(' ')
}

function extractSystemPrompt(system: KiroBetaParams['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .filter(b => (b.type ?? 'text') === 'text' && b.text)
    .map(b => b.text as string)
    .join('\n')
}

/** Text of a tool_result block (string content or text sub-blocks). */
function toolResultText(b: AnyObj): string {
  const content = b.content
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const cb of blocksOf(content)) {
    if (cb.type === 'text' && typeof cb.text === 'string') parts.push(cb.text)
  }
  return parts.join('\n')
}

// --- JSON Schema sanitization (drop keywords Kiro rejects) ------------------
const UNSUPPORTED_KEYWORDS = new Set([
  'additionalProperties', '$schema', 'propertyNames', 'default',
  'exclusiveMinimum', 'exclusiveMaximum', '$defs', '$ref', 'patternProperties',
  'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'prefixItems',
  'unevaluatedProperties', 'unevaluatedItems', 'contentMediaType',
  'contentEncoding', 'format', 'pattern', 'minLength', 'maxLength', 'minimum',
  'maximum', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf', 'not',
])

function isObj(v: unknown): v is AnyObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function sanitizeJSONSchema(schema: unknown): Record<string, unknown> {
  if (!isObj(schema)) return {}
  const result: AnyObj = {}
  // First pass: non-combinator keys.
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue
    if (key === 'const') {
      result.enum = [value]
    } else if (key === 'required') {
      if (Array.isArray(value) && value.length === 0) continue
      result[key] = value
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      // second pass
    } else if (isObj(value)) {
      result[key] = sanitizeJSONSchema(value)
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => (isObj(item) ? sanitizeJSONSchema(item) : item))
    } else {
      result[key] = value
    }
  }
  // Second pass: combinators (override deterministically).
  for (const [key, value] of Object.entries(schema)) {
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value) && value.length > 0) {
      const merged = flattenEnumBranches(value)
      if (merged) {
        Object.assign(result, merged)
      } else {
        const nonNull = value.filter(b => !(isObj(b) && b.type === 'null'))
        if (nonNull.length === 1 && isObj(nonNull[0])) {
          Object.assign(result, sanitizeJSONSchema(nonNull[0]))
        } else if (isObj(value[0])) {
          Object.assign(result, sanitizeJSONSchema(value[0]))
        }
      }
    } else if (key === 'allOf' && Array.isArray(value)) {
      for (const item of value) if (isObj(item)) Object.assign(result, sanitizeJSONSchema(item))
    }
  }
  return result
}

function flattenEnumBranches(branches: unknown[]): AnyObj | null {
  if (branches.length === 0) return null
  const allEnums: unknown[] = []
  let typ = ''
  let typConsistent = true
  for (const branch of branches) {
    if (!isObj(branch)) return null
    const sanitized = sanitizeJSONSchema(branch)
    if (!Array.isArray(sanitized.enum)) return null
    allEnums.push(...(sanitized.enum as unknown[]))
    if (typeof sanitized.type === 'string') {
      if (typ === '') typ = sanitized.type
      else if (typ !== sanitized.type) typConsistent = false
    } else {
      typConsistent = false
    }
  }
  const merged: AnyObj = { enum: allEnums }
  if (typ !== '' && typConsistent) merged.type = typ
  return merged
}

// --- Tools ------------------------------------------------------------------
function convertTools(tools: AnyObj[] | undefined, nameMap: ToolNameMap): KiroToolEntry[] {
  if (!tools?.length) return []
  const entries: KiroToolEntry[] = []
  for (const t of tools) {
    if (!t?.name) continue
    // Anthropic server tools (web_search…) carry a non-custom `type` and no
    // input_schema — no Kiro equivalent, drop them.
    if (typeof t.type === 'string' && t.type !== 'custom' && !t.input_schema) continue
    const name = nameMap.shorten(t.name as string)
    entries.push({
      toolSpecification: {
        name,
        description: (t.description as string) || `Tool: ${t.name as string}`,
        inputSchema: { json: sanitizeJSONSchema(t.input_schema) },
      },
    })
  }
  return entries
}

// --- Tool results / images --------------------------------------------------
function toolResultFrom(b: AnyObj): KiroToolResult {
  const isError = b.is_error === true
  let text = toolResultText(b)
  if (text === '') text = '(empty result)'
  return {
    toolUseId: b.tool_use_id as string,
    status: isError ? 'error' : 'success',
    content: [{ json: { exit_status: isError ? '1' : '0', stdout: text, stderr: '' } }],
  }
}

function imageFrom(b: AnyObj): KiroImage | null {
  const src = b.source as AnyObj | undefined
  if (!src || src.type !== 'base64' || typeof src.data !== 'string') return null
  let format = (src.media_type as string) || 'image/png'
  const idx = format.lastIndexOf('/')
  if (idx >= 0) format = format.slice(idx + 1)
  return { format, source: { bytes: src.data } }
}

function scanCurrentMessage(content: unknown): {
  toolResults: KiroToolResult[]
  images: KiroImage[]
} {
  const toolResults: KiroToolResult[] = []
  const images: KiroImage[] = []
  for (const b of blocksOf(content)) {
    if (b.type === 'tool_result') toolResults.push(toolResultFrom(b))
    else if (b.type === 'image') {
      const img = imageFrom(b)
      if (img) images.push(img)
    }
  }
  return { toolResults, images }
}

function extractToolResults(content: unknown): KiroToolResult[] {
  const out: KiroToolResult[] = []
  for (const b of blocksOf(content)) if (b.type === 'tool_result') out.push(toolResultFrom(b))
  return out
}

function extractToolUses(content: unknown, nameMap: ToolNameMap): KiroHistoryToolUse[] {
  const out: KiroHistoryToolUse[] = []
  for (const b of blocksOf(content)) {
    if (b.type === 'tool_use') {
      out.push({ toolUseId: b.id as string, name: nameMap.shorten(b.name as string), input: b.input ?? {} })
    }
  }
  return out
}

function extractToolUseIDs(msg: AnyObj): string[] {
  return blocksOf(msg.content)
    .filter(b => b.type === 'tool_use')
    .map(b => b.id as string)
}

function reorderToolResults(results: KiroToolResult[], toolUseIDs: string[]): KiroToolResult[] {
  if (results.length <= 1 || toolUseIDs.length === 0) return results
  const index = new Map(results.map(r => [r.toolUseId, r]))
  const used = new Set<string>()
  const ordered: KiroToolResult[] = []
  for (const id of toolUseIDs) {
    const r = index.get(id)
    if (r) {
      ordered.push(r)
      used.add(id)
    }
  }
  for (const r of results) if (!used.has(r.toolUseId)) ordered.push(r)
  return ordered
}

// --- Message normalization pipeline -----------------------------------------
type NMsg = { role: string; content: string | AnyObj[] }

function toNMsgs(messages: AnyObj[]): NMsg[] {
  return messages.map(m => ({
    role: m.role as string,
    content: isStringContent(m.content) ? m.content : blocksOf(m.content),
  }))
}

function isPlainText(content: string | AnyObj[]): boolean {
  if (typeof content === 'string') return true
  return content.every(b => b.type === 'text')
}

function textualizeAllToolContent(msgs: NMsg[]): NMsg[] {
  return msgs.map(msg => {
    if (typeof msg.content === 'string') return msg
    const blocks: AnyObj[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        blocks.push({ type: 'text', text: `[Tool: ${b.name} (${b.id})]\n${JSON.stringify(b.input ?? {})}` })
      } else if (b.type === 'tool_result') {
        blocks.push({ type: 'text', text: `[Tool Result (${b.tool_use_id})]\n${toolResultText(b)}` })
      } else {
        blocks.push(b)
      }
    }
    return { role: msg.role, content: blocks }
  })
}

function textualizeOrphanToolResults(msgs: NMsg[]): NMsg[] {
  return msgs.map((msg, i) => {
    if (msg.role !== 'user' || typeof msg.content === 'string') return msg
    const assistantToolIDs = new Set<string>()
    const prev = msgs[i - 1]
    if (i > 0 && prev && prev.role === 'assistant' && typeof prev.content !== 'string') {
      for (const b of prev.content) if (b.type === 'tool_use') assistantToolIDs.add(b.id as string)
    }
    const blocks: AnyObj[] = []
    for (const b of msg.content) {
      if (b.type === 'tool_result' && !assistantToolIDs.has(b.tool_use_id as string)) {
        blocks.push({ type: 'text', text: `[Tool Result (${b.tool_use_id})]\n${toolResultText(b)}` })
      } else {
        blocks.push(b)
      }
    }
    return { role: msg.role, content: blocks }
  })
}

function mergeAdjacentSameRole(msgs: NMsg[]): NMsg[] {
  if (msgs.length === 0) return msgs
  const result: NMsg[] = []
  let i = 0
  while (i < msgs.length) {
    let j = i + 1
    if (isPlainText(msgs[i]!.content)) {
      while (j < msgs.length && msgs[j]!.role === msgs[i]!.role && isPlainText(msgs[j]!.content)) j++
    }
    if (j === i + 1) {
      result.push(msgs[i]!)
      i = j
      continue
    }
    const parts: string[] = []
    for (let k = i; k < j; k++) parts.push(extractText(msgs[k]!.content))
    result.push({ role: msgs[i]!.role, content: parts.join('\n') })
    i = j
  }
  return result
}

function normalizeRoles(msgs: NMsg[]): NMsg[] {
  return msgs.map(m => (m.role !== 'user' && m.role !== 'assistant' ? { ...m, role: 'user' } : m))
}

function ensureStartsWithUser(msgs: NMsg[]): NMsg[] {
  if (msgs.length === 0 || msgs[0]!.role === 'user') return msgs
  return [{ role: 'user', content: SYNTHETIC_EMPTY }, ...msgs]
}

function ensureAlternatingRoles(msgs: NMsg[]): NMsg[] {
  if (msgs.length <= 1) return msgs
  const result: NMsg[] = [msgs[0]!]
  for (const msg of msgs.slice(1)) {
    const last = result[result.length - 1]!
    if (msg.role === last.role) {
      result.push({ role: msg.role === 'assistant' ? 'user' : 'assistant', content: SYNTHETIC_EMPTY })
    }
    result.push(msg)
  }
  return result
}

function normalize(messages: AnyObj[], hasTools: boolean): NMsg[] {
  let msgs = toNMsgs(messages)
  msgs = hasTools ? textualizeOrphanToolResults(msgs) : textualizeAllToolContent(msgs)
  msgs = normalizeRoles(msgs)
  msgs = mergeAdjacentSameRole(msgs)
  msgs = ensureStartsWithUser(msgs)
  msgs = ensureAlternatingRoles(msgs)
  return msgs
}

// --- History ----------------------------------------------------------------
function buildHistory(msgs: NMsg[], nameMap: ToolNameMap): KiroHistoryEntry[] {
  const history: KiroHistoryEntry[] = []
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!
    if (msg.role === 'user') {
      const content = extractText(msg.content)
      let toolResults = extractToolResults(msg.content)
      const prev = msgs[i - 1]
      if (toolResults.length > 1 && i > 0 && prev && prev.role === 'assistant') {
        toolResults = reorderToolResults(toolResults, extractToolUseIDs({ content: prev.content }))
      }
      history.push({
        userInputMessage: {
          content,
          origin: ORIGIN,
          ...(toolResults.length ? { userInputMessageContext: { toolResults } } : {}),
        },
      })
    } else if (msg.role === 'assistant') {
      const content = extractText(msg.content)
      const toolUses = extractToolUses(msg.content, nameMap)
      const seed = `assistant-msg:${content}${toolUses.map(t => `:${t.toolUseId}`).join('')}`
      history.push({
        assistantResponseMessage: {
          messageId: uuidV5(seed),
          content,
          ...(toolUses.length ? { toolUses } : {}),
        },
      })
    }
  }
  return history
}

function placeSystemPrompt(
  systemPrompt: string,
  history: KiroHistoryEntry[],
): KiroHistoryEntry[] {
  if (systemPrompt === '') return history
  return [
    { userInputMessage: { content: systemPrompt, origin: ORIGIN } },
    { assistantResponseMessage: { messageId: SYNTHETIC_ACK_MESSAGE_ID, content: SYNTHETIC_ACK } },
    ...history,
  ]
}

// --- Public builder ---------------------------------------------------------
export type BuildKiroResult = {
  payload: KiroPayload
  toolNames: ToolNameMap
  /** Kiro SKU sent as modelId (dot notation). */
  kiroModel: string
}

/**
 * Convert Anthropic Messages params into a Kiro CodeWhisperer payload.
 * Mirrors reqconv.BuildPayload. The model id is resolved to its Kiro SKU and
 * may enable thinking (via the `[1m]` suffix or an explicit thinking param),
 * which is injected as a `<thinking_mode>` prefix on the current message.
 */
export function buildKiroPayload(params: KiroBetaParams): BuildKiroResult {
  const nameMap = new ToolNameMap()
  const wantThinking = !!params.thinking && params.thinking.type !== 'disabled'
  // Send the BASE Kiro SKU. The current Kiro rejects `-1m` model ids with
  // "Invalid model ID" (that was the old kirocc convention) — only opus's
  // always-1M plain ids are valid. So never emit a -1m suffix; thinking is
  // signaled separately, not via the model id.
  const resolved = resolveKiroModel(params.model)
  const kiroModel = resolved.kiroModel.replace(/-1m$/, '')
  const thinking = resolved.thinking || wantThinking
  const thinkingBudget = params.thinking?.budget_tokens || DEFAULT_THINKING_BUDGET

  const systemPrompt = extractSystemPrompt(params.system)
  const hasTools = !!params.tools?.length
  const toolEntries = convertTools(params.tools, nameMap)

  const msgs = normalize(params.messages, hasTools)

  // Split history vs last message. If the last is from the assistant, all go to
  // history and we send a synthetic "Continue" user turn.
  let historyMsgs: NMsg[]
  let lastMsg: NMsg
  if (msgs.length === 0) {
    historyMsgs = []
    lastMsg = { role: 'user', content: SYNTHETIC_CONTINUE }
  } else if (msgs[msgs.length - 1]!.role === 'assistant') {
    historyMsgs = msgs
    lastMsg = { role: 'user', content: SYNTHETIC_CONTINUE }
  } else {
    historyMsgs = msgs.slice(0, -1)
    lastMsg = msgs[msgs.length - 1]!
  }

  let history = buildHistory(historyMsgs, nameMap)
  history = placeSystemPrompt(systemPrompt, history)

  const precedingToolUseIDs =
    historyMsgs.length > 0
      ? extractToolUseIDs({ content: historyMsgs[historyMsgs.length - 1]!.content })
      : []

  // Build the current user message.
  let lastContent = extractText(lastMsg.content)
  const { toolResults: rawToolResults, images } = scanCurrentMessage(lastMsg.content)
  const toolResults = reorderToolResults(rawToolResults, precedingToolUseIDs)

  const userMsg: KiroUserInputMessage = { content: lastContent, modelId: kiroModel, origin: ORIGIN }
  if (toolEntries.length > 0 || toolResults.length > 0) {
    userMsg.userInputMessageContext = {
      ...(toolEntries.length ? { tools: toolEntries } : {}),
      ...(toolResults.length ? { toolResults } : {}),
    }
  }
  // tool-result-only turns keep empty content; otherwise synth "Continue".
  if (userMsg.content === '' && toolResults.length === 0) {
    userMsg.content = SYNTHETIC_CONTINUE
  }
  if (images.length > 0) userMsg.images = images

  // Inject thinking-mode XML (skip for tool-result-only continuations).
  if (thinking && (userMsg.content !== '' || toolResults.length === 0)) {
    const prefix = `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${thinkingBudget}</max_thinking_length>`
    userMsg.content = userMsg.content !== '' ? `${prefix}\n\n${userMsg.content}` : prefix
  }

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: CHAT_TRIGGER_MANUAL,
      agentTaskType: AGENT_TASK_VIBE,
      currentMessage: { userInputMessage: userMsg },
      ...(history.length ? { history } : {}),
    },
  }
  return { payload, toolNames: nameMap, kiroModel }
}
