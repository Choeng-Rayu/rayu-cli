/**
 * Build integrity and boundary guards for the Rayucode VS Code extension.
 *
 * Asserts against the staged artifacts in dist/vscode/ and dist/vscode-stage/:
 *  - extension.js is CJS, contains require("vscode"), has no ESM statements, no jsx-runtime,
 *    and is strictly under MAX_HOST_BYTES (1_600_000).
 *  - webview.js contains React and no node: builtin; contains acquireVsCodeApi.
 *  - engine.mjs has exactly one shebang line.
 *  - dist/rayu.js contains no require("vscode"), proving the CLI never reaches extension code.
 *  - copilot.css contains no hex literals (100% theme tokens).
 *  - The VSIX contains no source maps and contains expected entries.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

const ROOT = resolve(import.meta.dir, '..')
const OUT_DIR = join(ROOT, 'dist/vscode')
const STAGE_DIR = join(ROOT, 'dist/vscode-stage')
const CLI_PATH = join(ROOT, 'dist/rayu.js')
const VSIX_PATH = join(ROOT, `dist/rayucode-${pkg.version}.vsix`)
const COPILOT_CSS_SRC = join(ROOT, 'src/vscode/webview/styles/copilot.css')

const artifactsPresent =
  existsSync(join(OUT_DIR, 'extension.js')) &&
  existsSync(join(OUT_DIR, 'webview.js')) &&
  existsSync(join(OUT_DIR, 'engine.mjs'))

test.if(existsSync(VSIX_PATH))('packaged engine starts under Node inside the extension package scope', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-package-startup-'))
  try {
    const unzip = spawnSync('unzip', ['-q', VSIX_PATH, '-d', directory], { encoding: 'utf8' })
    expect(unzip.status, unzip.stderr).toBe(0)
    const extensionDir = join(directory, 'extension')
    const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'))
    expect(manifest.type).toBe('commonjs')
    // Discover the shipped filename so this also reproduces the original .js bug.
    const engines = readdirSync(extensionDir).filter(name => /^engine\.m?js$/.test(name))
    expect(engines).toHaveLength(1)
    const result = spawnSync('node', [join(extensionDir, engines[0]!), '--help'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, RAYU_CONFIG_DIR: directory },
    })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: rayu')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

describe.if(artifactsPresent)('Rayucode build integrity and boundary guards', () => {
  const extensionJs = readFileSync(join(OUT_DIR, 'extension.js'), 'utf8')
  const webviewJs = readFileSync(join(OUT_DIR, 'webview.js'), 'utf8')
  const engineJs = readFileSync(join(OUT_DIR, 'engine.mjs'), 'utf8')

  describe('extension.js invariants (extension host bundle)', () => {
    test('is CommonJS and leaves vscode external', () => {
      expect(/require\(\s*["']vscode["']\s*\)/.test(extensionJs)).toBe(true)
    })

    test('contains no ESM import/export statements', () => {
      expect(/^\s*(?:import|export)\s/m.test(extensionJs)).toBe(false)
    })

    test('does not pull in react or ink (no terminal or web UI in host)', () => {
      expect(/["']react\/jsx-runtime["']/.test(extensionJs)).toBe(false)
      expect(/require\(\s*["']react["']\s*\)/.test(extensionJs)).toBe(false)
      expect(/require\(\s*["']ink["']\s*\)/.test(extensionJs)).toBe(false)
    })

    test('stays strictly under the 1,600,000 byte purity budget', () => {
      const MAX_HOST_BYTES = 1_600_000
      expect(extensionJs.length).toBeLessThanOrEqual(MAX_HOST_BYTES)
    })
  })

  describe('webview.js invariants (browser bundle)', () => {
    test('contains React runtime symbols', () => {
      expect(webviewJs.length).toBeGreaterThan(50_000)
      expect(webviewJs.includes('react') || webviewJs.includes('useState')).toBe(true)
    })

    test('contains no node: builtins', () => {
      expect(/require\(\s*["']node:(\w+)["']\s*\)/.test(webviewJs)).toBe(false)
      expect(/from\s+["']node:/.test(webviewJs)).toBe(false)
    })

    test('interacts with VS Code via acquireVsCodeApi', () => {
      expect(webviewJs.includes('acquireVsCodeApi')).toBe(true)
    })
  })

  describe('engine.mjs invariants (child process bundle)', () => {
    test('has exactly one shebang line', () => {
      const shebangs = (engineJs.match(/^#!.*$/gm) ?? []).filter(line =>
        line.startsWith('#!'),
      )
      expect(shebangs.length).toBe(1)
      expect(shebangs[0]).toBe('#!/usr/bin/env node')
    })
  })

  describe('copilot.css theme token hygiene', () => {
    test('source stylesheet contains no hardcoded hex color literals', () => {
      const srcCss = readFileSync(COPILOT_CSS_SRC, 'utf8')
      const hexMatches = srcCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(hexMatches).toEqual([])
    })

    test('bundled webview.css contains no hardcoded hex color literals (excluding minified transparent)', () => {
      const bundledCss = readFileSync(join(OUT_DIR, 'webview.css'), 'utf8')
      const hexMatches = (bundledCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).filter(
        hex => hex.toLowerCase() !== '#0000',
      )
      expect(hexMatches).toEqual([])
    })
  })

  describe('CLI bundle boundary isolation', () => {
    test.if(existsSync(CLI_PATH))('dist/rayu.js contains no vscode references', () => {
      const cliJs = readFileSync(CLI_PATH, 'utf8')
      expect(/require\(\s*["']vscode["']\s*\)/.test(cliJs)).toBe(false)
      expect(/from\s+["']vscode["']/.test(cliJs)).toBe(false)
    })
  })

  describe('VSIX packaging and staging contents', () => {
    test('staged package has no sourcemaps', () => {
      expect(existsSync(join(STAGE_DIR, 'extension.js.map'))).toBe(false)
      expect(existsSync(join(STAGE_DIR, 'engine.mjs.map'))).toBe(false)
      expect(existsSync(join(STAGE_DIR, 'media/webview.js.map'))).toBe(false)
    })

    test.if(existsSync(VSIX_PATH))('VSIX package contains expected entries and no source maps', () => {
      const res = Bun.spawnSync(['unzip', '-l', VSIX_PATH], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(res.exitCode).toBe(0)
      const output = res.stdout.toString()

      // Expected key files
      expect(output).toContain('extension/package.json')
      expect(output).toContain('extension/extension.js')
      expect(output).toContain('extension/engine.mjs')
      expect(output).toContain('extension/media/webview.js')
      expect(output).toContain('extension/media/webview.css')
      expect(output).toContain('extension/media/icon.svg')
      expect(output).toContain('extension/media/icon.png')
      expect(output).toContain('extension/readme.md')
      expect(output).toContain('extension/changelog.md')

      // No map files
      expect(output.includes('.map')).toBe(false)
    })
  })
})
