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
import hljs from 'highlight.js/lib/core'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'

// Register high-frequency coding languages with common aliases
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('patch', diff)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)

/**
 * Allowlist tuned to what a coding assistant actually emits.
 *
 * Safe tags only: formatting, lists, tables, code blocks with language headers and copy buttons.
 * No `img` (remote images are an exfiltration vector), no `iframe`, no `style`, no inline script handlers.
 */
const filter = new FilterXSS({
  whiteList: {
    p: [],
    br: [],
    strong: [],
    em: [],
    del: [],
    code: ['class'],
    pre: ['class'],
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
    div: ['class'],
    span: ['class', 'aria-hidden'],
    button: ['class', 'type', 'data-code', 'aria-label', 'title'],
  },
  // Drop the CONTENT of dangerous tags too. Without this, `<script>alert(1)</script>`
  // has its tags escaped but leaves `alert(1)` as visible text in the transcript.
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed'],
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

marked.setOptions({
  // Treat single newlines as line breaks. Models format for a chat window, and
  // without this a hand-wrapped paragraph collapses onto one line.
  breaks: true,
  gfm: true,
})

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang || '').toLowerCase().trim()
      const validLang = language && hljs.getLanguage(language) ? language : null
      const highlighted = validLang
        ? hljs.highlight(text, { language: validLang, ignoreIllegals: true }).value
        : escapeHtml(text)
      const encoded = encodeURIComponent(text)
      const displayLang = language || 'code'

      return (
        `<div class="rc-code-block">` +
        `<div class="rc-code-header">` +
        `<span class="rc-code-lang">${escapeHtml(displayLang)}</span>` +
        `<button type="button" class="rc-code-copy" data-code="${encoded}" title="Copy code" aria-label="Copy code">` +
        `<span class="rc-code-copy-text">Copy</span>` +
        `</button>` +
        `</div>` +
        `<pre><code class="hljs${validLang ? ` language-${validLang}` : ''}">${highlighted}</code></pre>` +
        `</div>\n`
      )
    },
  },
})

/**
 * Map a file path to a registered highlight.js language, or null.
 *
 * Only the extensions the languages above actually cover. An unknown extension returns
 * null and the caller escapes the text instead of highlighting it — guessing a language
 * mis-colours code, which is worse than plain text because it looks authoritative.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  css: 'css',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  patch: 'diff',
  diff: 'diff',
}

export function languageForPath(filePath: string): string | null {
  const extension = filePath.split('.').pop()?.toLowerCase()
  if (!extension) return null
  const language = EXTENSION_LANGUAGES[extension]
  return language && hljs.getLanguage(language) ? language : null
}

/**
 * Highlight one line or block of code from a known file, as sanitised HTML.
 *
 * Shares this module's `hljs` registry and `filter` with the markdown renderer, so a
 * language added for fenced code blocks is immediately available to diffs and there is
 * one allowlist rather than two. Diff content is FILE content, so it is untrusted and
 * goes through the same sanitiser as everything else.
 *
 * `ignoreIllegals` matters here more than for markdown: a diff row is a fragment, so it
 * frequently is not valid standalone syntax — an unclosed brace, half a template literal.
 * Without it highlight.js throws on exactly the rows a diff is made of.
 */
export function highlightCode(code: string, filePath: string): string {
  const language = languageForPath(filePath)
  if (!language) return escapeHtml(code)
  return filter.process(
    hljs.highlight(code, { language, ignoreIllegals: true }).value,
  )
}

/** Render markdown to sanitised HTML with syntax highlighting and copy controls. */
export function renderMarkdown(source: string): string {  const html = marked.parse(source) as string
  return filter.process(html)
}
