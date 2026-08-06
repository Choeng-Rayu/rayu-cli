#!/usr/bin/env node
/*
 * Verifies the generated CSS for the UnoCSS/Tailwind split.
 *
 * WHY THIS IS A SCRIPT AND NOT A JEST TEST
 * Generating the studio's CSS means loading uno.config.ts, which imports the
 * ESM-only `unocss` package. ts-jest runs in a CommonJS VM, where that import
 * throws ("Cannot use import statement outside a module" / "A dynamic import
 * callback was invoked without --experimental-vm-modules"). Plain Node handles it,
 * so the generation half of the styling verification lives here and the config
 * shape half lives in studio/styling.test.ts.
 *
 * Run: npm run verify:styling
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import unocss from '@unocss/postcss';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
}

async function generateUno() {
  const entry = path.join(ROOT, 'studio/styles/uno.css');
  const res = await postcss([unocss({ configOrPath: path.join(ROOT, 'uno.config.ts') })]).process(
    fs.readFileSync(entry, 'utf8'),
    { from: entry },
  );
  return res.css;
}

async function generateTailwind() {
  const { default: cfg } = await import(path.join(ROOT, 'tailwind.config.js'));
  const res = await postcss([tailwindcss(cfg)]).process(
    '@tailwind base;@tailwind components;@tailwind utilities;',
    { from: path.join(ROOT, 'app/globals.css') },
  );
  return res.css;
}

console.log('\nUnoCSS output (studio):');
const uno = await generateUno();
check('non-empty', uno.length > 1000, `${uno.length} bytes`);
// 642 i-ph:* usages are why UnoCSS is retained rather than converted to Tailwind.
check('emits i-ph:* icon rules', /\.i-ph\\:/.test(uno));
// The custom `bolt` collection is built from studio/icons/*.svg.
check('emits i-bolt:* icon rules', /\.i-bolt\\:/.test(uno));
check('emits bolt theme variables', uno.includes('var(--bolt-elements'));
check('emits shortcut .transition-theme', /\.transition-theme/.test(uno));
check('emits shortcut .max-w-chat', /\.max-w-chat/.test(uno));
// Marketing utilities come from tailwind.config.js and appear only in rayu-web's
// own pages; finding them here would mean UnoCSS scanned outside studio/.
for (const cls of ['.text-rayu-green', '.bg-rayu-bg', '.bg-rayu-bg2']) {
  check(`does not emit marketing class ${cls}`, !uno.includes(cls));
}

console.log('\nTailwind output (marketing/dashboard):');
const tw = await generateTailwind();
check('non-empty', tw.length > 1000, `${tw.length} bytes`);
for (const marker of ['bolt-elements', 'max-w-chat', 'transition-theme', 'i-ph']) {
  check(`does not emit studio marker "${marker}"`, !tw.includes(marker));
}
// Guards against over-tightening the negation and silently un-styling the site.
check('still emits .text-rayu-green', tw.includes('.text-rayu-green'));
check('still emits .bg-rayu-bg', tw.includes('.bg-rayu-bg'));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length) process.exit(1);
