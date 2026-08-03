import fs from 'node:fs';
import path from 'node:path';

/**
 * Rayu Studio is styled by UnoCSS; the rest of rayu-web is Tailwind. Both run in
 * one PostCSS pipeline (postcss.config.js), which is only safe while the
 * invariants below hold. Each is breakable with a one-line config edit and the
 * breakage is visual rather than a build failure — hence these tests.
 *
 * SCOPE: this file asserts CONFIG SHAPE only. Verifying the generated CSS
 * requires loading uno.config.ts, which imports the ESM-only `unocss` package and
 * cannot be required from ts-jest's CommonJS VM. That half lives in
 * scripts/verify-styling.mjs (`npm run verify:styling`), which runs under plain
 * Node where the ESM import works.
 */

const ROOT = path.join(__dirname, '..');

/** Strip CSS/JS comments so an explanatory comment can't satisfy or fail a check. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every .css/.scss file under studio/styles. */
function studioStylesheets(): string[] {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(css|scss)$/.test(e.name) ? [p] : [];
    });
  return walk(path.join(ROOT, 'studio/styles'));
}

describe('uno.config.ts scoping', () => {
  /*
   * Read RAW, not comment-stripped. A naive comment stripper mangles the globs
   * themselves: 'studio/**\/*.{ts,tsx}' contains the sequence `/*`, so the
   * "comment" runs to the next `*` + `/` and the glob is silently rewritten to
   * 'studio*.{ts,tsx}'. The assertions below are specific enough not to need it.
   */
  const src = fs.readFileSync(path.join(ROOT, 'uno.config.ts'), 'utf8');

  it('uses content.filesystem, the only key @unocss/postcss reads', () => {
    /*
     * The Vite plugin reads content.pipeline.include; the PostCSS plugin reads
     * content.filesystem and, when it is absent, silently falls back to scanning
     * the entire project. That fallback would make UnoCSS emit utilities for the
     * Tailwind-owned marketing pages, which is the exact conflict being avoided.
     */
    expect(src).toMatch(/content:\s*\{\s*filesystem:\s*\[/);
    expect(src).not.toMatch(/content:\s*\{\s*pipeline:/);
  });

  it('scans only the studio subtree', () => {
    const block = /filesystem:\s*\[([^\]]*)\]/.exec(src);
    expect(block).not.toBeNull();
    const globs = (block![1].match(/'[^']+'/g) ?? []).map((g) => g.slice(1, -1));
    expect(globs.length).toBeGreaterThan(0);
    for (const g of globs) {
      expect(g).toMatch(/^(studio|app\/studio)\//);
    }
  });

  it('builds its custom icon collection from the copied studio icons', () => {
    // bolt globbed ./icons/*.svg; the tree moved to studio/icons during the port.
    expect(src).toContain("globSync('./studio/icons/*.svg')");
  });
});

describe('tailwind.config.js scoping', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(path.join(ROOT, 'tailwind.config.js'));

  it('excludes app/studio, which its ./app/** glob would otherwise match', () => {
    expect(cfg.content).toContain('!./app/studio/**');
  });

  it('does not list the studio component tree at all', () => {
    const positive = (cfg.content as string[]).filter((g) => !g.startsWith('!'));
    for (const g of positive) {
      expect(g).not.toMatch(/^\.\/studio\//);
    }
  });
});

describe('postcss.config.js pipeline', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(path.join(ROOT, 'postcss.config.js'));
  const names = Object.keys(cfg.plugins);

  /*
   * UnoCSS is referenced by PATH, not by package name. Next loads PostCSS
   * plugins with `require(plugin)(options)` and does not unwrap an ESM default
   * export, while @unocss/postcss's CJS build exports { default: fn } — so naming
   * the package fails the build with "require(...) is not a function" pointing
   * into Next's own source. postcss/unocss.cjs adapts it.
   */
  const UNOCSS_PLUGIN = './postcss/unocss.cjs';

  it('runs both engines', () => {
    expect(names).toContain(UNOCSS_PLUGIN);
    expect(names).toContain('tailwindcss');
    expect(names).toContain('autoprefixer');
  });

  it('does not reference @unocss/postcss by package name', () => {
    // Would build locally under plain PostCSS and fail only under `next build`.
    expect(names).not.toContain('@unocss/postcss');
  });

  it('ships the CJS adapter the path points at', () => {
    const adapter = path.join(ROOT, 'postcss/unocss.cjs');
    expect(fs.existsSync(adapter)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(typeof require(adapter)).toBe('function');
  });

  it('expands UnoCSS directives before autoprefixer sees the result', () => {
    expect(names.indexOf(UNOCSS_PLUGIN)).toBeLessThan(names.indexOf('autoprefixer'));
  });

  it('points UnoCSS at the repo config', () => {
    expect(cfg.plugins[UNOCSS_PLUGIN]).toMatchObject({ configOrPath: './uno.config.ts' });
  });
});

describe('studio stylesheets are self-contained', () => {
  it('does not import a second CSS reset', () => {
    /*
     * Tailwind Preflight is already global via app/globals.css. Adding UnoCSS's
     * tailwind-compat reset would restyle the marketing pages to fix a problem the
     * studio does not have.
     */
    for (const f of studioStylesheets()) {
      expect(stripComments(fs.readFileSync(f, 'utf8'))).not.toMatch(/@unocss\/reset/);
    }
  });

  it('has no unresolved @apply left for the PostCSS pipeline', () => {
    // bolt used @apply / --at-apply in 2 files; both were inlined so the build
    // never depends on a directive transformer running over imported CSS.
    for (const f of studioStylesheets()) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      expect(src).not.toMatch(/@apply\b/);
      expect(src).not.toMatch(/--at-apply\b/);
    }
  });

  it('has a UnoCSS entry stylesheet for the studio layout to import', () => {
    const entry = path.join(ROOT, 'studio/styles/uno.css');
    expect(fs.existsSync(entry)).toBe(true);
    expect(fs.readFileSync(entry, 'utf8')).toMatch(/@unocss;/);
  });
});

describe('icon references resolve', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ph = require('@iconify-json/ph/icons.json') as {
    icons: Record<string, unknown>;
    aliases?: Record<string, unknown>;
  };
  const known = new Set([...Object.keys(ph.icons), ...Object.keys(ph.aliases ?? {})]);

  /** Studio source files, excluding this test (which contains example names). */
  function studioSources(): string[] {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) return walk(p);
        if (!/\.(ts|tsx)$/.test(e.name)) return [];
        if (/\.(test|spec)\.tsx?$/.test(e.name)) return [];
        return [p];
      });
    return walk(path.join(ROOT, 'studio'));
  }

  it('uses no Phosphor icon name absent from @iconify-json/ph', () => {
    /*
     * bolt.diy shipped three names that do not exist in the Phosphor set, so they
     * rendered blank upstream: `filter-duotone` (Phosphor calls it `funnel`),
     * `lock-closed` (it is `lock`), and `git-repository` (no such icon). UnoCSS
     * only warns at build time, so a bad name is easy to reintroduce unnoticed.
     */
    const missing: string[] = [];
    for (const f of studioSources()) {
      const src = fs.readFileSync(f, 'utf8');
      // Both separators are valid for presetIcons: i-ph:name and i-ph-name.
      for (const m of src.matchAll(/i-ph[:-]([a-z0-9-]+)/g)) {
        const name = m[1];
        // A capture ending in '-' is the static prefix of a template literal
        // (e.g. `i-ph:caret-${...}`); those are covered by the safelist test below.
        if (name.endsWith('-')) continue;
        if (!known.has(name)) missing.push(`${path.relative(ROOT, f)}: i-ph:${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('safelists every icon built with a template literal', () => {
    /*
     * UnoCSS extracts candidates by scanning source text, so `i-ph:${cond ? 'a' :
     * 'b'}` is invisible to it. Such icons render only while the same name happens
     * to appear statically in another component — remove that last static use and
     * the icon silently disappears. uno.config.ts therefore safelists them.
     */
    const src = fs.readFileSync(path.join(ROOT, 'uno.config.ts'), 'utf8');
    const safelisted = new Set(
      (/dynamicIconSafelist\s*=\s*\[([^\]]*)\]/.exec(src)?.[1].match(/'[^']+'/g) ?? []).map((s) =>
        s.slice(1, -1),
      ),
    );

    const dynamicSites: string[] = [];
    for (const f of studioSources()) {
      const source = fs.readFileSync(f, 'utf8');
      for (const m of source.matchAll(/i-ph[:-]([a-z0-9-]*)\$\{([^}]*)\}/g)) {
        const prefix = m[1];
        const body = m[2];
        /*
         * Take only the RESULT branches of a ternary, not every string literal in
         * the expression. All three sites are of the form
         *   `i-ph:${cond === 'x' ? 'a' : 'b'}`
         * and a naive literal scan would also pick up the comparison operand 'x'
         * — which for DiffView.tsx is 'binary', itself a real Phosphor icon name,
         * so filtering by "is a known icon" cannot separate the two.
         */
        const ternary = /\?\s*'([a-z0-9-]+)'\s*:\s*'([a-z0-9-]+)'/g;
        let found = false;
        for (const t of body.matchAll(ternary)) {
          found = true;
          dynamicSites.push(`i-ph:${prefix}${t[1]}`, `i-ph:${prefix}${t[2]}`);
        }
        if (!found) {
          // Not a ternary: fall back to every literal, erring toward over-reporting
          // so a new expression shape fails loudly rather than being skipped.
          for (const lit of body.matchAll(/'([a-z0-9-]+)'/g)) {
            dynamicSites.push(`i-ph:${prefix}${lit[1]}`);
          }
        }
      }
    }

    // Sanity: the scan must actually find the known dynamic sites, or the regex
    // has drifted and this test would silently pass while covering nothing.
    expect(dynamicSites.length).toBeGreaterThan(0);

    const unsafelisted = [...new Set(dynamicSites)].filter((c) => !safelisted.has(c));
    expect(unsafelisted).toEqual([]);
  });
});
