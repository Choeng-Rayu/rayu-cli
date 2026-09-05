// Markdown → React elements.
//
// ## Why this is safer than the renderer it replaces
//
// The previous implementation hand-built an HTML STRING and was careful to be
// "escape-first": escape every run of text, then emit a small fixed set of tags.
// That is sound, but it puts the burden of correctness on ~300 lines of bespoke
// escaping and regex, which is exactly the kind of code that grows subtle holes.
//
// This module never produces an HTML string at all. `marked` is used only as a
// LEXER, and the resulting token tree is mapped to React elements. React escapes
// every text child by construction, and `dangerouslySetInnerHTML` appears nowhere
// in this file (or anywhere in the webview). There is therefore no HTML-injection
// surface to get wrong — not "escaped correctly", but "no parse step to escape".
//
// The security properties the previous module's 67 tests pinned down are all
// preserved, and most become structural rather than enforced:
//
//   - HTML in the source is inert. `marked` is configured so raw HTML is emitted
//     as `html` tokens, and this renderer prints their raw text as a STRING
//     child, so `<img onerror=…>` renders as visible characters.
//   - Link schemes are still validated by {@link isSafeHref}: only http, https,
//     mailto, tel, or scheme-less. Anything else renders as plain text with no
//     anchor, so `javascript:` cannot become a clickable target.
//   - Attribute breakout is impossible: `href` is passed as a React prop, never
//     interpolated into markup.
//   - Control characters and NUL are stripped before scheme checks, matching
//     browser normalisation.
//   - Catastrophic backtracking is not a concern: the bespoke nested-emphasis
//     regexes are gone, and `marked` is a maintained linear-time lexer.
//
// {@link escapeHtml} is retained and exported because other call sites still use
// it, and because the security suite pins its behaviour.

import { marked, type Token, type Tokens } from "marked";
import type { JSX, ReactNode } from "react";

// ----------------------------------------------------------------------------
// Escaping and URL safety
// ----------------------------------------------------------------------------

/**
 * Escape the five HTML-significant characters.
 *
 * `&` is replaced FIRST so the entities introduced by the later replacements are
 * not themselves re-encoded (which would double-encode and corrupt the output).
 *
 * React escapes text children on its own, so this is not needed for rendering.
 * It is kept for callers that build plain-text labels and for the security suite.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Schemes a link may use. Everything else renders as inert text. */
const ALLOWED_LINK_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

/**
 * Whether a URL is safe to place in an `href`.
 *
 * A scheme-less URL (relative path or `#fragment`) is allowed. A URL WITH a
 * scheme is allowed only if that scheme is in {@link ALLOWED_LINK_SCHEMES}.
 *
 * Control characters — including NUL, tabs and newlines — are stripped before
 * the scheme is read, because browsers ignore them when resolving a URL. Without
 * that step `java\0script:alert(1)` or `java\tscript:alert(1)` would read as
 * scheme-less here while still executing in the browser.
 */
export function isSafeHref(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const normalized = url.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
  if (scheme === null) {
    return true;
  }
  return ALLOWED_LINK_SCHEMES.has(scheme[1] as string);
}

// ----------------------------------------------------------------------------
// Token → React
// ----------------------------------------------------------------------------

/**
 * Lex markdown without generating HTML.
 *
 * `gfm` gives tables and strikethrough. `breaks` maps a single newline to a line
 * break, which matches how assistant output is written.
 */
function lex(source: string): Token[] {
  return marked.lexer(source, { gfm: true, breaks: true });
}

/** Render inline tokens (the children of a paragraph, heading, cell, …). */
function renderInline(tokens: readonly Token[] | undefined): ReactNode[] {
  if (tokens === undefined) {
    return [];
  }
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const key = `i${index}`;
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        // A text token may itself carry inline children (e.g. inside a table
        // cell). Prefer them so nested emphasis still renders.
        out.push(
          t.tokens && t.tokens.length > 0 ? (
            <span key={key}>{renderInline(t.tokens)}</span>
          ) : (
            t.text
          ),
        );
        break;
      }
      case "escape":
        out.push((token as Tokens.Escape).text);
        break;
      case "strong":
        out.push(
          <strong key={key}>
            {renderInline((token as Tokens.Strong).tokens)}
          </strong>,
        );
        break;
      case "em":
        out.push(
          <em key={key}>{renderInline((token as Tokens.Em).tokens)}</em>,
        );
        break;
      case "del":
        out.push(<s key={key}>{renderInline((token as Tokens.Del).tokens)}</s>);
        break;
      case "codespan":
        // `marked` HTML-encodes codespan text for its HTML output. Decode the
        // handful of entities it introduces so React does not display them
        // literally, then let React escape the result on render.
        out.push(<code key={key}>{decodeBasicEntities((token as Tokens.Codespan).text)}</code>);
        break;
      case "br":
        out.push(<br key={key} />);
        break;
      case "link": {
        const t = token as Tokens.Link;
        const children = renderInline(t.tokens);
        if (!isSafeHref(t.href)) {
          // Disallowed scheme: render the label and the raw target as inert
          // text. Nothing clickable is produced.
          out.push(
            <span key={key} title="Link removed: unsupported URL scheme">
              {children}
            </span>,
          );
          break;
        }
        out.push(
          <a
            key={key}
            href={t.href}
            title={t.title ?? undefined}
            // Defence in depth for the webview's link handling.
            rel="noopener noreferrer"
          >
            {children}
          </a>,
        );
        break;
      }
      case "image": {
        const t = token as Tokens.Image;
        // Images are NOT rendered. The CSP allows only host-served and data:
        // images, so a remote <img> would be blocked anyway, and rendering one
        // is a request the panel should never make on the model's behalf.
        out.push(
          <span key={key} className="md-image-placeholder">
            {`🖼 ${t.text || t.href}`}
          </span>,
        );
        break;
      }
      case "html":
        // Raw HTML in the source is INERT: printed as a text child, so React
        // escapes it and the user sees the markup rather than executing it.
        out.push((token as Tokens.HTML).raw);
        break;
      default: {
        // Unknown inline token: fall back to its raw source text. Never
        // interpreted, only displayed.
        const raw = (token as { raw?: unknown }).raw;
        if (typeof raw === "string") {
          out.push(raw);
        }
        break;
      }
    }
  });
  return out;
}

/** Decode only the entities `marked` introduces into codespan text. */
function decodeBasicEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Render one list, honouring ordered/`start`/task-list. */
function renderList(token: Tokens.List, key: string): ReactNode {
  const items = token.items.map((item, index) => (
    <li key={`li${index}`} className={item.task ? "md-task" : undefined}>
      {item.task ? (
        <input
          type="checkbox"
          checked={item.checked === true}
          readOnly
          // A rendered checkbox must not be operable: it reflects model output,
          // not user state, and toggling it would imply an action that is not
          // wired to anything.
          aria-label={item.checked === true ? "completed" : "not completed"}
          tabIndex={-1}
        />
      ) : null}
      {renderBlocks(item.tokens, `${key}li${index}`)}
    </li>
  ));
  return token.ordered ? (
    <ol key={key} start={typeof token.start === "number" ? token.start : undefined}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

/** Render block-level tokens. */
function renderBlocks(
  tokens: readonly Token[] | undefined,
  keyPrefix: string,
): ReactNode[] {
  if (tokens === undefined) {
    return [];
  }
  const out: ReactNode[] = [];
  tokens.forEach((token, index) => {
    const key = `${keyPrefix}b${index}`;
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
        out.push(
          <p key={key}>{renderInline((token as Tokens.Paragraph).tokens)}</p>,
        );
        break;
      case "text": {
        const t = token as Tokens.Text;
        out.push(
          <span key={key}>
            {t.tokens && t.tokens.length > 0 ? renderInline(t.tokens) : t.text}
          </span>,
        );
        break;
      }
      case "heading": {
        const t = token as Tokens.Heading;
        const depth = Math.min(Math.max(t.depth, 1), 6);
        const Tag = `h${depth}` as keyof JSX.IntrinsicElements;
        out.push(<Tag key={key}>{renderInline(t.tokens)}</Tag>);
        break;
      }
      case "code": {
        const t = token as Tokens.Code;
        out.push(
          <pre key={key} className="md-code-block">
            <code
              // The language is advisory only — used for a CSS hook, never to
              // select an executor.
              className={t.lang ? `language-${sanitizeLangToken(t.lang)}` : undefined}
            >
              {t.text}
            </code>
          </pre>,
        );
        break;
      }
      case "blockquote":
        out.push(
          <blockquote key={key}>
            {renderBlocks((token as Tokens.Blockquote).tokens, key)}
          </blockquote>,
        );
        break;
      case "list":
        out.push(renderList(token as Tokens.List, key));
        break;
      case "hr":
        out.push(<hr key={key} />);
        break;
      case "table": {
        const t = token as Tokens.Table;
        out.push(
          <table key={key} className="md-table">
            <thead>
              <tr>
                {t.header.map((cell, c) => (
                  <th key={`h${c}`} style={alignStyle(t.align[c])}>
                    {renderInline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={`r${r}`}>
                  {row.map((cell, c) => (
                    <td key={`c${c}`} style={alignStyle(t.align[c])}>
                      {renderInline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        break;
      }
      case "html":
        // Inert — see the inline `html` case.
        out.push(<p key={key}>{(token as Tokens.HTML).raw}</p>);
        break;
      default: {
        const raw = (token as { raw?: unknown }).raw;
        if (typeof raw === "string" && raw.trim().length > 0) {
          out.push(<p key={key}>{raw}</p>);
        }
        break;
      }
    }
  });
  return out;
}

/** Restrict a fence's language to a CSS-class-safe token. */
function sanitizeLangToken(lang: string): string {
  return lang.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9_+-]/g, "") ?? "";
}

/**
 * Column alignment as a React style object.
 *
 * Set via the `style` prop, which React applies through the CSSOM. That is not
 * an inline `style` attribute in parsed HTML, so it does not require
 * `'unsafe-inline'` in the panel's `style-src` CSP directive.
 */
function alignStyle(
  align: "center" | "left" | "right" | null | undefined,
): { textAlign: "center" | "left" | "right" } | undefined {
  return align ? { textAlign: align } : undefined;
}

// ----------------------------------------------------------------------------
// Public entry point
// ----------------------------------------------------------------------------

/**
 * Render markdown as React nodes.
 *
 * Never returns HTML and never uses `dangerouslySetInnerHTML`. A lexer failure
 * on pathological input degrades to plain text rather than throwing, so a
 * malformed model response cannot blank the panel.
 */
export function renderMarkdown(source: string): ReactNode {
  if (source.length === 0) {
    return null;
  }
  // Strip NUL up front. It has no visual representation and only serves to
  // confuse downstream string handling.
  const cleaned = source.replace(/\0/g, "");
  let tokens: Token[];
  try {
    tokens = lex(cleaned);
  } catch {
    return <p>{cleaned}</p>;
  }
  return <>{renderBlocks(tokens, "")}</>;
}
