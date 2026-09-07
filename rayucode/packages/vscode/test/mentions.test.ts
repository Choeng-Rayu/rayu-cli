/**
 * `@`-mentions — UI_PARITY flow 20.
 *
 * The panel already captured selections and staged files, but there was no way to
 * REFERENCE a file while composing: you had to know and type the whole path.
 *
 * The rules pinned here are the ones that make the difference between a helpful
 * picker and one that fires in the middle of ordinary prose.
 */
import { describe, expect, it } from "vitest";

import {
  MENTION_LIMIT,
  applyMention,
  parseMentionQuery,
  rankMentionCandidates,
} from "../src/webview/mentions.js";

describe("finding the mention under the caret", () => {
  it("finds a mention being typed", () => {
    expect(parseMentionQuery("look at @src/app", 16)).toEqual({
      query: "src/app",
      start: 8,
      end: 16,
    });
  });

  it("finds a bare @ so the picker opens immediately", () => {
    expect(parseMentionQuery("check @", 7)).toEqual({ query: "", start: 6, end: 7 });
  });

  it("finds a mention at the very start", () => {
    expect(parseMentionQuery("@main.ts", 8)?.query).toBe("main.ts");
  });

  it("ignores an email address", () => {
    // The `@` is not at a word boundary, so offering files here is noise.
    expect(parseMentionQuery("mail user@example.com", 21)).toBeNull();
  });

  it("ignores a decorator or handle inside a word", () => {
    expect(parseMentionQuery("call obj@prop", 13)).toBeNull();
  });

  it("stops at whitespace, so an earlier @ does not match", () => {
    // "@src" is a completed mention; the caret is in a later word.
    expect(parseMentionQuery("@src then more", 14)).toBeNull();
  });

  it("returns null with no @ at all", () => {
    expect(parseMentionQuery("just a prompt", 13)).toBeNull();
  });

  it("accepts an @ after an opening bracket or quote", () => {
    // Common when referencing a file inside a sentence or a code snippet.
    expect(parseMentionQuery('see ("@src', 10)?.query).toBe("src");
  });

  it("rejects an out-of-range caret rather than throwing", () => {
    expect(parseMentionQuery("@a", 99)).toBeNull();
    expect(parseMentionQuery("@a", -1)).toBeNull();
  });
});

describe("ranking file candidates", () => {
  const paths = [
    "src/app.ts",
    "src/legacy/app/other.ts",
    "test/app.test.ts",
    "docs/appendix.md",
    "src/zzz.ts",
  ];

  it("prefers a filename match over a match elsewhere in the path", () => {
    // Typing "@app" means app.ts, not a file inside a directory called app.
    const ranked = rankMentionCandidates("app", paths);
    expect(ranked[0]).toBe("src/app.ts");
    expect(ranked.indexOf("src/legacy/app/other.ts")).toBeGreaterThan(
      ranked.indexOf("src/app.ts"),
    );
  });

  it("prefers a filename PREFIX over a filename substring", () => {
    const ranked = rankMentionCandidates("app", paths);
    expect(ranked.indexOf("docs/appendix.md")).toBeLessThan(
      ranked.indexOf("test/app.test.ts"),
    );
  });

  it("omits non-matches entirely rather than ranking them last", () => {
    expect(rankMentionCandidates("app", paths)).not.toContain("src/zzz.ts");
  });

  it("is case-insensitive", () => {
    expect(rankMentionCandidates("APP", paths)).toContain("src/app.ts");
  });

  it("keeps the host's order for an empty query", () => {
    // The host already chose a sensible default set; re-sorting would discard that.
    expect(rankMentionCandidates("", paths)).toEqual(paths);
  });

  it("caps the list", () => {
    const many = Array.from({ length: 50 }, (_, i) => `src/app${i}.ts`);
    expect(rankMentionCandidates("app", many)).toHaveLength(MENTION_LIMIT);
  });

  it("is stable for equal scores", () => {
    const a = rankMentionCandidates("app", paths);
    const b = rankMentionCandidates("app", paths);
    expect(a).toEqual(b);
  });
});

describe("inserting a chosen path", () => {
  it("replaces the mention and leaves the caret after a trailing space", () => {
    const text = "look at @src/ap and fix";
    const mention = parseMentionQuery(text, 15);
    expect(mention).not.toBeNull();
    const result = applyMention(text, mention!, "src/app.ts");
    expect(result.text).toBe("look at @src/app.ts  and fix");
    // Caret sits after the inserted space, ready for more typing.
    expect(result.text.slice(0, result.caret)).toBe("look at @src/app.ts ");
  });

  it("replaces a bare @ without eating surrounding text", () => {
    const text = "see @";
    const result = applyMention(text, parseMentionQuery(text, 5)!, "a.ts");
    expect(result.text).toBe("see @a.ts ");
  });
});
