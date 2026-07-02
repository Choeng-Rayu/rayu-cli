// Safe Markdown → HTML renderer for the Agent_Panel (R3.7).
//
// Assistant message content is Markdown and MUST be rendered as formatted
// output, with fenced code blocks in monospace (R3.7). It is also UNTRUSTED:
// the agent (or, through it, a tool result or web page) can emit arbitrary
// text. So this renderer is escape-FIRST and emits only a small, fixed subset
// of tags — there is no path by which raw input reaches the DOM unescaped.
//
// Design (security-first):
//   1. Every run of text is HTML-escaped BEFORE any markup is produced, so
//      `<script>` and friends can never become live elements.
//   2. Only a known subset of block/inline constructs is emitted:
//        headings (#..######), unordered/ordered lists, paragraphs,
//        fenced code blocks (```), inline code (`x`), bold (** / __),
//        italic (* / _), and links [text](url).
//   3. Link hrefs are validated against an allow-list of URL schemes; anything
//      else (javascript:, data:, vbscript:, …) is dropped to plain text.
//   4. No raw HTML passthrough, no images-from-markdown, no remote anything —
//      which, combined with the webview's strict CSP, means no remote content
//      can be loaded.
//
// The renderer is a pure string→string function: it touches no DOM and is unit
// testable in Node. The DOM layer assigns its output via `innerHTML` to a
// container, which is safe precisely because every emitted byte is either an
// escaped literal or one of the fixed tags this module controls.

/** Escape the five HTML-significant characters. Always called before markup. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Reverse the {@link escapeHtml} entities — used only for href scheme checks. */
function unescapeHtml(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** URL schemes permitted in a rendered link. Everything else is dropped. */
const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Whether `url` is safe to use as a link href. A url WITHOUT a scheme (a
 * relative path or `#fragment`) is allowed; a url WITH a scheme is allowed only
 * if the scheme is in {@link ALLOWED_LINK_SCHEMES}. Control characters and
 * whitespace are stripped first so tricks like `java\tscript:` (which browsers
 * would normalize back to `javascript:`) cannot slip through.
 */
export function isSafeHref(url: string): boolean {
  // Strip ASCII control chars + spaces the browser would otherwise ignore.
  const cleaned = url.replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (scheme === null) {
    // No scheme ⇒ relative URL or fragment ⇒ safe (cannot execute script).
    return true;
  }
  return ALLOWED_LINK_SCHEMES.has(scheme[1].toLowerCase());
}

/** A placeholder sentinel for protected inline-code spans (never in input). */
const CODE_SENTINEL = "\u0000";

/**
 * Render inline Markdown within a single already-trimmed line of text. Returns
 * safe HTML. Input is escaped FIRST; all subsequent matching runs against the
 * escaped string, so every captured fragment is already safe to embed.
 */
function renderInline(raw: string): string {
  // Drop any literal NULs so the code-span sentinel is unambiguous.
  const escaped = escapeHtml(raw.replace(/\u0000/g, ""));

  // 1) Protect inline-code spans first so their contents are not interpreted as
  //    bold/italic/link markup. The captured text is already HTML-escaped.
  const codeSpans: string[] = [];
  let text = escaped.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return `${CODE_SENTINEL}${index}${CODE_SENTINEL}`;
  });

  // 2) Links: [text](url). `linkText` and `url` are already escaped; the scheme
  //    is validated on the HTML-unescaped url. Unsafe links degrade to text.
  text = text.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_match, linkText: string, url: string) => {
      if (!isSafeHref(unescapeHtml(url))) {
        return linkText;
      }
      // `url` stays in its escaped form (so `"` is `&quot;`), safe in the attr.
      return `<a href="${url}" rel="noopener noreferrer">${linkText}</a>`;
    },
  );

  // 3) Bold before italic so `**x**` is not eaten by the single-delimiter rule.
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // 4) Italic. The underscore form requires boundaries so it does not fire
  //    inside snake_case_identifiers.
  text = text
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, "$1<em>$2</em>");

  // 5) Restore protected code spans.
  text = text.replace(
    new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, "g"),
    (_match, index: string) => codeSpans[Number(index)] ?? "",
  );

  return text;
}

/** Render the list items of a `<ul>`/`<ol>` block. */
function renderListItems(items: string[]): string {
  return items.map((item) => `<li>${renderInline(item)}</li>`).join("");
}

/**
 * Render a Markdown string to safe HTML. Block constructs are recognized
 * line-by-line; everything else becomes a paragraph. Fenced code blocks are
 * emitted verbatim (escaped) inside `<pre><code>` for monospace (R3.7).
 */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];

  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (listType !== null) {
      out.push(`<${listType}>${renderListItems(listItems)}</${listType}>`);
      listType = null;
      listItems = [];
    }
  };
  const flushBlocks = (): void => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Fenced code block: collect verbatim until the closing fence (or EOF).
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence !== null) {
      flushBlocks();
      const body: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (/^\s*```\s*$/.test(lines[i] ?? "")) {
          break;
        }
        body.push(lines[i] ?? "");
      }
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Blank line ⇒ block separator.
    if (/^\s*$/.test(line)) {
      flushBlocks();
      continue;
    }

    // ATX heading: #..###### followed by text.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushBlocks();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    // Unordered list item: -, *, or + followed by text.
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (unordered !== null) {
      flushParagraph();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      listItems.push(unordered[1]);
      continue;
    }

    // Ordered list item: `1.` or `1)` followed by text.
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flushParagraph();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      listItems.push(ordered[1]);
      continue;
    }

    // Anything else is paragraph text; a list cannot continue through it.
    flushList();
    paragraph.push(line.trim());
  }

  flushBlocks();
  return out.join("");
}
