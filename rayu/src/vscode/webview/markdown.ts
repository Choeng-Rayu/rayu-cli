/**
 * Markdown rendering for assistant output.
 *
 * ── WHY THE SANITISER IS NOT OPTIONAL ──────────────────────────────────────────
 *
 * This renders text produced by a language model, and tool output produced by
 * arbitrary files and commands. Both are untrusted. `marked` emits raw HTML for raw
 * HTML in its input by design, so passing its output straight to
 * `dangerouslySetInnerHTML` would let a model response — or a README being
 * summarised — inject script into the editor.
 *
 * The webview's CSP is the second layer and would block an inline `<script>`, but
 * defence in depth matters here because CSP does not stop everything an injected tag
 * can do (`<img onerror>` is blocked by `script-src`, a phishing `<form>` is not).
 * `xss` allowlists tags and attributes, so anything unexpected is escaped rather
 * than rendered.
 *
 * Both `marked` and `xss` are already dependencies of this repository, so this adds
 * nothing to install.
 */
import { marked } from 'marked'
import { FilterXSS } from 'xss'

/**
 * Allowlist tuned to what a coding assistant actually emits.
 *
 * No `img` (a transcript has no use for remote images, and it is a tracking vector),
 * no `iframe`, no `style`, no event handlers. Links keep `href` and `title` only.
 */
const filter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    em: [],
    del: [],
    code: ['class'],
    pre: [],
    blockquote: [],
    ul: [],
    ol: ['start'],
    li: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    h6: [],
    hr: [],
    a: ['href', 'title'],
    table: [],
    thead: [],
    tbody: [],
    tr: [],
    th: ['align'],
    td: ['align'],
  },
  // Drop the CONTENT of dangerous tags too. Without this, `<script>alert(1)</script>`
  // has its tags escaped but leaves `alert(1)` as visible text in the transcript.
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
})

marked.setOptions({
  // Treat single newlines as line breaks. Models format for a chat window, and
  // without this a hand-wrapped paragraph collapses onto one line.
  breaks: true,
  gfm: true,
})

/** Render markdown to sanitised HTML. Never returns unsanitised output. */
export function renderMarkdown(source: string): string {
  // `marked.parse` is synchronous unless async extensions are registered; none are.
  const html = marked.parse(source) as string
  return filter.process(html)
}
