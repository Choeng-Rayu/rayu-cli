/**
 * npm-consumption compatibility — RAYU_CORE_MIGRATION_PLAN.md Task 13.
 *
 * The extension consumes core as a real npm dependency under plain Node with NO
 * bundler, which is a different contract from the CLI's: rayu lets Bun inline
 * every import into dist/rayu.js, so an unresolvable specifier there is invisible
 * until runtime. Here, every specifier core emits must resolve from the published
 * tarball plus its declared dependencies — nothing else.
 *
 * This asserts that statically against the BUILT output, so it runs in CI without
 * a network. It was validated for real once by packing core, installing the
 * tarball into an empty Node project and importing it: 2 packages installed
 * (core + zod), all exports working, no `Bun` global, and no native `.node`
 * binaries anywhere in the tree.
 *
 * The rule this enforces is the one that already caught a regression: a
 * `createRequire('yaml')` fallback in core is invisible to Bun's bundler, so the
 * package was not inlined and the CLI threw `Cannot find module 'yaml'` when run
 * from a directory without node_modules. Only Node BUILTINS may be required
 * lazily from core.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  files?: string[];
  main?: string;
  types?: string;
};

/** Node builtins, with and without the `node:` prefix. */
const BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "dns", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process", "querystring",
  "readline", "stream", "string_decoder", "timers", "tls", "tty", "url", "util",
  "v8", "vm", "worker_threads", "zlib",
]);

function isBuiltin(spec: string): boolean {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  return BUILTINS.has(bare.split("/")[0] ?? "");
}

/**
 * Every emitted .js file, RECURSIVELY.
 *
 * Not optional: `rootDir: "src"` mirrors the source tree, so the portable modules
 * land in `dist/portable/` and a flat `readdirSync` silently skips them — which is
 * exactly where the lazy-require rule matters most. A non-recursive walk made this
 * suite pass while a deliberately reintroduced `nodeRequire('yaml')` went
 * undetected.
 */
function emittedFiles(dir: string = DIST): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...emittedFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/**
 * Real import specifiers, via the TypeScript AST rather than a regex.
 *
 * A regex over the emitted JS reports specifiers that appear inside doc comments
 * — `features.ts` documents `import { feature } from 'bun:bundle'` in its header
 * and tsc preserves comments, so a textual scan flags core as importing a
 * Bun-only module it deliberately does not import. That is the same class of
 * false positive that made the migration's original `Bun.*` and `feature()`
 * counts wrong, so this uses the parser.
 */
function specifiersIn(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const out: string[] = [];

  const add = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) out.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      // `require` and any createRequire() binding, e.g. core's `nodeRequire`.
      const isRequire =
        ts.isIdentifier(node.expression) && /require$/i.test(node.expression.text);
      if (isDynamicImport || isRequire) add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Only `require(...)` calls, for the builtin-only rule. */
function lazyRequiresIn(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      // `require`, and any binding produced by createRequire() — core uses
      // `nodeRequire`. Matching only the literal name `require` would miss the
      // exact pattern this rule exists to police.
      /require$/i.test(node.expression.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("core is consumable as a plain npm dependency", () => {
  it("has been built", () => {
    // Everything below inspects the emitted output, so a missing build would make
    // the assertions vacuous.
    expect(emittedFiles().length, "run `npm run build` first").toBeGreaterThan(0);
    expect(existsSync(join(DIST, "index.js"))).toBe(true);
    expect(existsSync(join(DIST, "index.d.ts"))).toBe(true);
  });

  it("every emitted specifier is a builtin, a declared dependency, or relative", () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);

    const offenders: string[] = [];
    for (const file of emittedFiles()) {
      for (const spec of specifiersIn(file, readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") || spec.startsWith("/")) continue;
        if (isBuiltin(spec)) continue;
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : (spec.split("/")[0] ?? spec);
        if (declared.has(pkg)) continue;
        offenders.push(`${file.replace(ROOT, ".")}: ${spec}`);
      }
    }
    expect(offenders, "undeclared specifier — it would not resolve for the extension").toEqual(
      [],
    );
  });

  it("lazy requires target ONLY node builtins", () => {
    // The regression this exists for: a lazy require of an npm PACKAGE is
    // invisible to Bun's bundler, so it is not inlined into dist/rayu.js and the
    // CLI — which ships zero runtime dependencies — throws at runtime.
    for (const file of emittedFiles()) {
      const source = readFileSync(file, "utf8");
      for (const spec of lazyRequiresIn(file, source)) {
        if (spec.startsWith(".")) continue;
        expect(
          isBuiltin(spec),
          `${file.replace(ROOT, ".")} lazily requires "${spec}", which is not a builtin. ` +
            "Only builtins are safe: an npm package required this way is not bundled " +
            "into dist/rayu.js and breaks the CLI's zero-runtime-dependency install.",
        ).toBe(true);
      }
    }
  });

  it("declares no native modules", () => {
    // sharp, modifiers-napi and the OTEL exporters stay behind optional dynamic
    // imports on the CLI side; none of them may become a dependency of core, or
    // installing the extension would start compiling prebuilds.
    const all = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    for (const name of Object.keys(all)) {
      expect(name, `${name} looks native`).not.toMatch(/-napi$|^sharp$/);
    }
  });

  it("ships dist and nothing else", () => {
    expect(manifest.files).toEqual(["dist", "README.md"]);
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });

  it("npm pack contains the built output and no sources", () => {
    // `npm pack --dry-run --json` needs no network.
    const raw = execSync("npm pack --dry-run --json", { cwd: ROOT, encoding: "utf8" });
    const files = (JSON.parse(raw) as { files: { path: string }[] }[])[0]?.files ?? [];
    const paths = files.map((f) => f.path);
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/index.d.ts");
    // Consumers get declarations, not TypeScript sources.
    expect(paths.filter((p) => p.startsWith("src/"))).toEqual([]);
    expect(paths.filter((p) => p.startsWith("test/"))).toEqual([]);
  });
});
