/**
 * Render an AI Markdown response into Telegram-flavoured HTML.
 *
 * Telegram's `parse_mode: HTML` supports only a tiny tag set — `<b> <i> <u>
 * <s> <code> <pre> <a> <blockquote> <tg-spoiler>` — with strict nesting rules
 * (see https://core.telegram.org/bots/api#html-style):
 *   - inside <pre>/<code> no other tags may appear (only escaped text);
 *   - <blockquote> can't be nested and can't contain <pre>;
 *   - `<`, `>`, `&` must be HTML-escaped everywhere outside a tag.
 *
 * The model, however, emits full Markdown (headings, fenced code, lists,
 * tables, `**bold**`, links). Previously that Markdown was only HTML-escaped
 * and sent verbatim, so the raw syntax (`##`, `**`, ```` ``` ````) showed up
 * literally in the chat — the "messy" output. This module walks marked's token
 * AST (the same lexer src/utils/markdown.ts uses for the terminal) and maps
 * each node to the closest supported Telegram construct, degrading gracefully
 * where Telegram has no equivalent (headings → bold, lists → bullets, tables →
 * a monospace <pre> block, `---` → a divider).
 *
 * Every token emits balanced open/close tags, so the output is always valid
 * even for the partial Markdown produced mid-stream. As a last resort the
 * caller can strip the HTML with stripTelegramHtml() and resend as plain text
 * (telegramApi does this automatically if Telegram rejects the entities).
 */

import { marked, type Token, type Tokens } from 'marked'
import { escapeHtml } from './telegramApi.js'

// stripTelegramHtml lives in telegramApi (its HTML→plaintext fallback consumer)
// to keep the dependency direction one-way; re-exported here as the renderer's
// public companion so callers/tests can import both from one module.
export { stripTelegramHtml } from './telegramApi.js'

const NL = '\n'

/** Escape a value for use inside an HTML attribute (adds quote escaping). */
function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

/** Only these URL schemes are turned into links; anything else renders as text. */
function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|tg:\/\/)/i.test(href)
}

interface RenderCtx {
  /** Inside a <blockquote>: <pre>/<code>/nested <blockquote> aren't allowed. */
  inQuote: boolean
  /** Nesting depth of the current list, for indentation. */
  listDepth: number
}

const ROOT_CTX: RenderCtx = { inQuote: false, listDepth: 0 }

/**
 * Render Markdown to Telegram HTML. Returns '' for blank input and falls back
 * to plain escaped text if the lexer throws on malformed input.
 */
export function renderTelegramHtml(markdown: string): string {
  if (!markdown || !markdown.trim()) return ''
  let tokens: Token[]
  try {
    tokens = marked.lexer(markdown)
  } catch {
    return escapeHtml(markdown).trim()
  }
  const out = tokens.map((t) => renderToken(t, ROOT_CTX)).join('')
  // Collapse the runs of blank lines that block tokens leave behind.
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function renderChildren(tokens: Token[] | undefined, ctx: RenderCtx): string {
  if (!tokens) return ''
  return tokens.map((t) => renderToken(t, ctx)).join('')
}

/** Recursively extract only the visible text of inline tokens (for <pre>/tables). */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  return tokens
    .map((t) => {
      const withTokens = t as { tokens?: Token[]; text?: string }
      if (withTokens.tokens && withTokens.tokens.length) return plainText(withTokens.tokens)
      return withTokens.text ?? ''
    })
    .join('')
}

function renderToken(token: Token, ctx: RenderCtx): string {
  switch (token.type) {
    case 'space':
      return NL
    case 'br':
      return NL
    case 'escape':
      return escapeHtml(token.text)
    case 'text': {
      // Inline text may carry child tokens (em/strong/code inside a run).
      const inline = (token as { tokens?: Token[] }).tokens
      return inline && inline.length ? renderChildren(inline, ctx) : escapeHtml(token.text)
    }
    case 'paragraph':
      return renderChildren(token.tokens, ctx) + NL + NL
    case 'strong':
      return `<b>${renderChildren(token.tokens, ctx)}</b>`
    case 'em':
      return `<i>${renderChildren(token.tokens, ctx)}</i>`
    case 'del':
      return `<s>${renderChildren(token.tokens, ctx)}</s>`
    case 'codespan': {
      const inner = escapeHtml(token.text)
      // <code> can't live inside a <blockquote> — degrade to plain text there.
      return ctx.inQuote ? inner : `<code>${inner}</code>`
    }
    case 'code': {
      const body = escapeHtml(token.text.replace(/\n+$/, ''))
      // <pre> is illegal inside <blockquote>; emit plain indented text instead.
      if (ctx.inQuote) return body + NL
      const lang = token.lang ? token.lang.trim().split(/\s+/)[0] : ''
      return lang
        ? `<pre><code class="language-${escapeAttr(lang!)}">${body}</code></pre>${NL}`
        : `<pre>${body}</pre>${NL}`
    }
    case 'heading': {
      const inner = renderChildren(token.tokens, ctx)
      // Telegram has no heading tag: h1 → bold+underline, h2+ → bold.
      const html = token.depth <= 1 ? `<b><u>${inner}</u></b>` : `<b>${inner}</b>`
      return html + NL + NL
    }
    case 'hr':
      return '──────────' + NL + NL
    case 'blockquote': {
      // Nested blockquotes are illegal — flatten an inner quote into its parent.
      if (ctx.inQuote) return renderChildren(token.tokens, ctx)
      const inner = renderChildren(token.tokens, { ...ctx, inQuote: true }).trim()
      return inner ? `<blockquote>${inner}</blockquote>${NL}${NL}` : ''
    }
    case 'link': {
      const href = token.href ?? ''
      const text = renderChildren(token.tokens, ctx) || escapeHtml(token.text ?? href)
      if (href.startsWith('mailto:')) return escapeHtml(href.slice('mailto:'.length))
      if (!isSafeHref(href)) return text
      return `<a href="${escapeAttr(href)}">${text}</a>`
    }
    case 'image': {
      const alt = escapeHtml(token.text || 'image')
      const href = token.href ?? ''
      return isSafeHref(href) ? `🖼 <a href="${escapeAttr(href)}">${alt}</a>` : `🖼 ${alt}`
    }
    case 'list': {
      const start = typeof token.start === 'number' ? token.start : 1
      const items = token.items
        .map((item, i) => renderListItem(item, token.ordered ? start + i : null, ctx))
        .join('')
      return items + NL
    }
    case 'table':
      return renderTable(token as Tokens.Table, ctx)
    case 'html':
      // The model rarely emits raw HTML; show it literally rather than risk
      // injecting tags Telegram would reject.
      return escapeHtml(token.text)
    case 'def':
      return ''
    default:
      // Any token we don't special-case: fall back to its raw text if present.
      return escapeHtml((token as { text?: string }).text ?? '')
  }
}

function renderListItem(
  item: Token & { tokens?: Token[]; task?: boolean; checked?: boolean },
  orderedNumber: number | null,
  ctx: RenderCtx,
): string {
  const indent = '  '.repeat(ctx.listDepth)
  const childCtx: RenderCtx = { ...ctx, listDepth: ctx.listDepth + 1 }
  const inner = renderChildren(item.tokens, childCtx).trim()
  let marker: string
  if (item.task) marker = item.checked ? '☑' : '☐'
  else if (orderedNumber !== null) marker = `${orderedNumber}.`
  else marker = '•'
  return `${indent}${marker} ${inner}${NL}`
}

/**
 * Telegram has no table markup, so render a monospace <pre> block with padded
 * columns — the terminal's approach. Inside a blockquote (no <pre> allowed) or
 * on any failure, degrade to " | "-joined rows.
 */
function renderTable(token: Tokens.Table, ctx: RenderCtx): string {
  const header = token.header.map((c) => plainText(c.tokens).trim())
  const rows = token.rows.map((r) => r.map((c) => plainText(c.tokens).trim()))
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join('  ')
  const sep = widths.map((w) => '─'.repeat(w)).join('  ')
  const lines = [pad(header), sep, ...rows.map(pad)].join(NL)
  if (ctx.inQuote) return escapeHtml(lines) + NL + NL
  return `<pre>${escapeHtml(lines)}</pre>${NL}${NL}`
}
