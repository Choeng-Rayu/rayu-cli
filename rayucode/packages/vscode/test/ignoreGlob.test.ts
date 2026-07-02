import { describe, expect, it } from "vitest";

import {
  collectExcludeGlobs,
  globToRegExpSource,
  isIgnoredByGlobs,
  matchGlob,
  normalizeRelativePath,
} from "../src/ignoreGlob.js";

// Unit tests for the pure glob logic behind `VSCodeAdapter.isPathIgnored`
// (R9.6). These run under vitest in plain Node because the logic carries no
// `vscode` dependency; the adapter method that consumes it is covered by the
// extension-host integration suite (src/test/suite) that runs in a real editor.
describe("globToRegExpSource", () => {
  it("escapes regex metacharacters in literal segments", () => {
    expect(globToRegExpSource("a.b+c")).toBe("a\\.b\\+c");
  });

  it("maps '*' to a single-segment wildcard", () => {
    expect(globToRegExpSource("*.log")).toBe("[^/]*\\.log");
  });

  it("maps '?' to a single non-separator character", () => {
    expect(globToRegExpSource("file?.ts")).toBe("file[^/]\\.ts");
  });

  it("maps a leading '**/' to zero-or-more path segments", () => {
    expect(globToRegExpSource("**/node_modules")).toBe(
      "(?:[^/]+/)*node_modules",
    );
  });

  it("maps a trailing '**' to match across separators", () => {
    expect(globToRegExpSource("dist/**")).toBe("dist/.*");
  });

  it("expands brace alternation", () => {
    expect(globToRegExpSource("*.{js,ts}")).toBe("[^/]*\\.(?:js|ts)");
  });
});

describe("matchGlob", () => {
  it("matches a basename glob only within a single segment", () => {
    expect(matchGlob("foo.log", "*.log")).toBe(true);
    expect(matchGlob("nested/foo.log", "*.log")).toBe(false);
  });

  it("matches '**/' at any depth, including zero", () => {
    expect(matchGlob("node_modules", "**/node_modules")).toBe(true);
    expect(matchGlob("a/node_modules", "**/node_modules")).toBe(true);
    expect(matchGlob("a/b/node_modules", "**/node_modules")).toBe(true);
  });

  it("matches a globstar in the middle of a pattern", () => {
    expect(matchGlob("a/b", "a/**/b")).toBe(true);
    expect(matchGlob("a/x/y/b", "a/**/b")).toBe(true);
    expect(matchGlob("a/x/y/c", "a/**/b")).toBe(false);
  });

  it("honors brace alternation", () => {
    expect(matchGlob("main.ts", "*.{js,ts}")).toBe(true);
    expect(matchGlob("main.css", "*.{js,ts}")).toBe(false);
  });
});

describe("normalizeRelativePath", () => {
  it("converts separators and strips leading ./ and /", () => {
    expect(normalizeRelativePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelativePath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelativePath("src\\a.ts")).toBe("src/a.ts");
  });
});

describe("isIgnoredByGlobs", () => {
  it("ignores a file matching an exclude glob", () => {
    expect(isIgnoredByGlobs("build/output.js", ["build/**"])).toBe(true);
  });

  it("ignores files inside an excluded directory (directory glob)", () => {
    // "**/node_modules" excludes the dir itself AND everything beneath it.
    expect(isIgnoredByGlobs("node_modules", ["**/node_modules"])).toBe(true);
    expect(
      isIgnoredByGlobs("node_modules/dep/index.js", ["**/node_modules"]),
    ).toBe(true);
    expect(
      isIgnoredByGlobs("packages/x/node_modules/dep.js", ["**/node_modules"]),
    ).toBe(true);
  });

  it("does not ignore a non-matching path", () => {
    expect(isIgnoredByGlobs("src/index.ts", ["**/node_modules", "dist/**"])).toBe(
      false,
    );
  });

  it("normalizes absolute-looking and backslash paths before matching", () => {
    expect(isIgnoredByGlobs("/dist/a.js", ["dist/**"])).toBe(true);
    expect(isIgnoredByGlobs("dist\\a.js", ["dist/**"])).toBe(true);
  });

  it("returns false when there are no globs", () => {
    expect(isIgnoredByGlobs("anything/at/all.ts", [])).toBe(false);
  });
});

describe("collectExcludeGlobs", () => {
  it("collects enabled globs and drops disabled ones", () => {
    const filesExclude = { "**/.git": true, "**/.DS_Store": false };
    const searchExclude = { "**/node_modules": true };
    expect(collectExcludeGlobs(filesExclude, searchExclude).sort()).toEqual(
      ["**/.git", "**/node_modules"].sort(),
    );
  });

  it("treats a `{ when }` condition object as enabled (pragmatic)", () => {
    const filesExclude = { "**/*.js": { when: "$(basename).ts" } };
    expect(collectExcludeGlobs(filesExclude)).toEqual(["**/*.js"]);
  });

  it("dedupes globs across sources and ignores non-objects", () => {
    expect(
      collectExcludeGlobs(
        { "**/node_modules": true },
        { "**/node_modules": true },
        undefined,
        null,
        "not-an-object",
      ),
    ).toEqual(["**/node_modules"]);
  });
});
