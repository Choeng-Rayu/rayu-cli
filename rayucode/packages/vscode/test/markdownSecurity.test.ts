import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  isSafeHref,
  renderMarkdown,
} from "../src/webview/markdown.js";

/**
 * Render markdown the way the panel does, then serialise to HTML so the
 * assertions below can inspect it.
 *
 * `renderMarkdown` returns React nodes, NOT an HTML string — that is the point.
 * `marked` is used only as a lexer and its token tree is mapped to React
 * elements, so no HTML is ever produced by the renderer and React escapes every
 * text child by construction. The serialisation here exists purely so the tests
 * can assert on the final DOM shape; production never takes this path.
 */
function renderHtml(source: string): string {
  return renderToStaticMarkup(renderMarkdown(source) as never);
}

// Adversarial sanitizer battery (R3.7 + the webview trust boundary).
//
// Assistant content is UNTRUSTED: the agent relays tool output, file contents, and
// fetched web pages, any of which an attacker may control.
//
// The renderer no longer produces an HTML string at all, and
// `dangerouslySetInnerHTML` appears nowhere in the webview — so there is no
// injection SINK to defend. These tests nonetheless still attack the renderer
// directly, because "there is no sink" is a property that must be re-verified,
// not assumed: a future change that reintroduces one has to fail here.
//
// The invariant under test: for ANY input, the rendered output contains no
// executable construct — no `<script>`, no event-handler attribute, no
// javascript:/data:/vbscript: URL — and every tag present belongs to the fixed
// allow-list the renderer emits.

/** Tags the renderer is permitted to emit. Anything else is a sanitizer escape. */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "strong",
  "em",
  "a",
  // Emitted by the React renderer for structures the previous string renderer
  // did not support. All are inert containers with no scripting capability.
  "span",
  "s",
  "del",
  "hr",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
]);

/** Every tag name appearing in `html`. */
function tagsIn(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) =>
    (m[1] ?? "").toLowerCase(),
  );
}

/** Assert `html` contains nothing that could execute. */
function expectInert(html: string, vector: string): void {
  const lower = html.toLowerCase();
  expect(lower, `<script> survived for: ${vector}`).not.toMatch(/<script/);
  expect(lower, `<iframe> survived for: ${vector}`).not.toMatch(/<iframe/);
  expect(lower, `<svg> survived for: ${vector}`).not.toMatch(/<svg/);
  expect(lower, `<img> survived for: ${vector}`).not.toMatch(/<img/);
  expect(lower, `<object/embed survived for: ${vector}`).not.toMatch(
    /<(object|embed|base|link|meta|form|style)/,
  );
  // An event-handler attribute requires `on…=` in TAG context. Escaped text such
  // as `&lt;img onerror=x&gt;` is inert, so only look outside escaped entities.
  expect(lower, `event handler survived for: ${vector}`).not.toMatch(
    /<[a-z][^>]*\son[a-z]+\s*=/,
  );
  for (const tag of tagsIn(html)) {
    expect(ALLOWED_TAGS.has(tag), `unexpected tag <${tag}> for: ${vector}`).toBe(
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Raw HTML injection
// ---------------------------------------------------------------------------

describe("renderMarkdown: raw HTML never becomes live markup", () => {
  const vectors = [
    `<script>alert(1)</script>`,
    `<img src=x onerror=alert(1)>`,
    `<svg/onload=alert(1)>`,
    `<iframe src="javascript:alert(1)"></iframe>`,
    `<body onload=alert(1)>`,
    `<a href="javascript:alert(1)">click</a>`,
    `<style>*{background:url(javascript:alert(1))}</style>`,
    `<base href="http://evil.test/">`,
    `<meta http-equiv="refresh" content="0;url=http://evil.test">`,
    `<form action="http://evil.test"><input name=x></form>`,
    `<object data="data:text/html,<script>alert(1)</script>"></object>`,
    `<!--<script>alert(1)</script>-->`,
    `<div onmouseover="alert(1)">hover</div>`,
    `<textarea></textarea><script>alert(1)</script>`,
    // Broken/partial markup a naive regex sanitizer would mis-handle.
    `<scr<script>ipt>alert(1)</script>`,
    `<<script>alert(1)</script>`,
    `<script`,
    `<script >alert(1)</script >`,
    `<SCRIPT>alert(1)</SCRIPT>`,
    `<script\n>alert(1)</script>`,
    `<script/xss>alert(1)</script>`,
    // Inside markdown constructs, where a nested renderer might drop its guard.
    `# <script>alert(1)</script>`,
    `- <img src=x onerror=alert(1)>`,
    `1. <script>alert(1)</script>`,
    `**<script>alert(1)</script>**`,
    `*<img src=x onerror=alert(1)>*`,
    `[<script>alert(1)</script>](http://ok.test)`,
    `\`<script>alert(1)</script>\``,
    "```\n<script>alert(1)</script>\n```",
  ];

  for (const vector of vectors) {
    it(`neutralizes ${JSON.stringify(vector).slice(0, 60)}`, () => {
      expectInert(renderHtml(vector), vector);
    });
  }

  it("escapes the angle brackets rather than dropping the text", () => {
    // Sanitizing by DELETION would silently hide content; escaping preserves it.
    const html = renderHtml("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// Link scheme enforcement
// ---------------------------------------------------------------------------

describe("renderMarkdown: dangerous link schemes are dropped", () => {
  const dangerous = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "JAVASCRIPT:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "about:blank",
    "blob:http://evil.test/x",
    "jAvAsCrIpT:alert(1)",
    // Control characters a browser strips before scheme resolution.
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "\u0001javascript:alert(1)",
    "javascript\u0000:alert(1)",
    // VS Code-specific schemes that could invoke commands.
    "command:workbench.action.terminal.new",
    "vscode://x",
  ];

  for (const url of dangerous) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      const html = renderHtml(`[click](${url})`);
      // Either the link degraded to plain text, or it was never emitted as an
      // href — never both an <a> AND the dangerous scheme.
      expect(html.toLowerCase()).not.toMatch(/href="[^"]*javascript/);
      expect(html.toLowerCase()).not.toMatch(/href="[^"]*vbscript/);
      expect(html.toLowerCase()).not.toMatch(/href="[^"]*data:/);
      expect(html.toLowerCase()).not.toMatch(/href="[^"]*command:/);
      expectInert(html, url);
    });
  }

  const safe = [
    "http://example.test/x",
    "https://example.test/x?a=1&b=2",
    "mailto:a@example.test",
    "tel:+15550100",
    "/relative/path",
    "#fragment",
  ];

  for (const url of safe) {
    it(`allows ${JSON.stringify(url)}`, () => {
      const html = renderHtml(`[click](${url})`);
      expect(html).toMatch(/<a href="/);
      expect(html).toContain('rel="noopener noreferrer"');
    });
  }

  it("cannot break out of the href attribute", () => {
    // A quote in the url would end the attribute if it were not escaped.
    const html = renderHtml(`[x](http://a.test/"onmouseover="alert(1))`);
    expect(html).not.toMatch(/<a[^>]*\son[a-z]+\s*=/i);
  });

  it("cannot inject a second attribute via whitespace", () => {
    // `[^)\s]+` forbids whitespace in the url, so this is not a link at all.
    const html = renderHtml(`[x](http://a.test onmouseover=alert(1))`);
    expect(html).not.toMatch(/<a[^>]*\son[a-z]+\s*=/i);
  });
});

// ---------------------------------------------------------------------------
// isSafeHref unit-level
// ---------------------------------------------------------------------------

describe("isSafeHref", () => {
  it("allows only http/https/mailto/tel plus scheme-less URLs", () => {
    expect(isSafeHref("http://a.test")).toBe(true);
    expect(isSafeHref("https://a.test")).toBe(true);
    expect(isSafeHref("mailto:a@b.test")).toBe(true);
    expect(isSafeHref("tel:+1")).toBe(true);
    expect(isSafeHref("/rel")).toBe(true);
    expect(isSafeHref("#frag")).toBe(true);

    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(isSafeHref("vbscript:x")).toBe(false);
    expect(isSafeHref("file:///etc/passwd")).toBe(false);
    expect(isSafeHref("command:x")).toBe(false);
  });

  it("normalizes control characters before deciding, like a browser does", () => {
    expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
    expect(isSafeHref("java\nscript:alert(1)")).toBe(false);
    expect(isSafeHref(" javascript:alert(1)")).toBe(false);
    expect(isSafeHref("\u0000javascript:alert(1)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes the ampersand first so entities are not double-decoded", () => {
    // If `<` were escaped before `&`, `&lt;` would round-trip to a real `<`.
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
  });
});

// ---------------------------------------------------------------------------
// Structural integrity — output must be well-formed, not just inert
// ---------------------------------------------------------------------------

describe("renderMarkdown: emphasis must not corrupt emitted markup", () => {
  it("does not inject tags into a link's href attribute", () => {
    // The emphasis passes run AFTER links are emitted, over a string that already
    // contains `href="…"`. A url containing `*` or `_` must not be rewritten.
    const html = renderHtml("[x](http://a.test/a*b*c)");
    const href = /href="([^"]*)"/.exec(html)?.[1];
    expect(href, "expected a link to be emitted").toBeDefined();
    expect(href).toBe("http://a.test/a*b*c");
  });

  it("does not inject tags into an href via underscores", () => {
    const html = renderHtml("[x](http://a.test/a__b__c)");
    const href = /href="([^"]*)"/.exec(html)?.[1];
    expect(href).toBe("http://a.test/a__b__c");
  });

  it("does not let emphasis span an emitted tag boundary", () => {
    // `*` inside the link text plus a trailing `*` must not wrap the `</a>`.
    const html = renderHtml("[*a](http://a.test)*");
    expect(html).not.toMatch(/<em>[^<]*<\/a>/);
  });

  it("keeps anchors properly nested", () => {
    const html = renderHtml("[a](http://a.test) and **bold**");
    // Every opened <a> is closed before the next block-level construct.
    const opens = (html.match(/<a\s/g) ?? []).length;
    const closes = (html.match(/<\/a>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

// ---------------------------------------------------------------------------
// Robustness — the renderer must never throw or hang on hostile input
// ---------------------------------------------------------------------------

describe("renderMarkdown: robustness", () => {
  it("never throws on pathological input", () => {
    const vectors = [
      "",
      "\n\n\n",
      "\u0000\u0000\u0000",
      "`".repeat(1000),
      "*".repeat(1000),
      "_".repeat(1000),
      "[".repeat(500) + "]".repeat(500),
      "#".repeat(100) + " heading",
      "```".repeat(100),
      "- ".repeat(500),
      "\r\n\r\n",
      "\u2028\u2029",
      "🙈".repeat(100),
      "a".repeat(50_000),
    ];
    for (const vector of vectors) {
      expect(() => renderHtml(vector), JSON.stringify(vector.slice(0, 20)))
        .not.toThrow();
    }
  });

  it("completes quickly on adversarial nesting (no catastrophic backtracking)", () => {
    // Nested delimiters are the classic ReDoS shape for hand-rolled inline rules.
    const hostile = `${"*".repeat(60)}a${"*".repeat(60)}`;
    const start = Date.now();
    renderMarkdown(hostile);
    renderMarkdown(`[${"a".repeat(5000)}](http://a.test)`);
    renderMarkdown(`${"`".repeat(200)}x${"`".repeat(200)}`);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("strips NUL so the code-span sentinel cannot be forged", () => {
    // The renderer uses \u0000 internally to protect code spans; input NULs must
    // not be able to impersonate one and pull an arbitrary span into place.
    const html = renderHtml("\u00000\u0000 `real`");
    expect(html).not.toContain("\u0000");
    expect(html).toContain("<code>real</code>");
  });

  it("closes an unterminated fenced code block at EOF", () => {
    const html = renderHtml("```\nunclosed <script>alert(1)</script>");
    // Asserts the STRUCTURE, not exact markup: the React renderer adds a CSS
    // class to the <pre>, which is irrelevant to the security property.
    expect(html).toMatch(/<pre[^>]*><code/);
    // The critical part — the script tag inside the fence is escaped text.
    expect(html).toContain("&lt;script&gt;");
    expectInert(html, "unterminated fence");
  });
});
