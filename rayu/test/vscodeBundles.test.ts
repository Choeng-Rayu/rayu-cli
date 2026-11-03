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
    // An agent that runs commands and loads the workspace .env must never run in
    // Restricted Mode; declared explicitly so it cannot be flipped by accident.
    expect(manifest.capabilities?.untrustedWorkspaces?.supported).toBe(false)
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

    test('does not bundle the Anthropic API client', () => {
      // The host makes no API calls; the engine child does. One root-entry import of
      // '@anthropic-ai/sdk' (utils/errors.ts, for an `instanceof`) once shipped the whole
      // client — ~390 KB, a quarter of this budget. Import narrow entries such as
      // '@anthropic-ai/sdk/error.js' from anything the host can reach.
      expect(extensionJs).not.toMatch(/^\/\/ \S*node_modules\/@anthropic-ai\/sdk\/client\.m?js$/m)
      expect(extensionJs).not.toMatch(/^\/\/ \S*node_modules\/@anthropic-ai\/sdk\/index\.m?js$/m)
      // A string only the client contains, so the guard still holds if this bundle is
      // ever minified and loses its module-path comments.
      expect(extensionJs).not.toContain('dangerouslyAllowBrowser')
    })

    test('ships zod with English messages only (the engine keeps every translation)', () => {
      // `zodEnglishLocalesOnlyPlugin` in scripts/bundleConfig.ts, applied by the host build
      // alone. The behaviour is exercised in test/vscodeZodLocales.test.ts; this checks the
      // real artifact, so dropping the plugin from build-vscode.ts is caught too.
      expect(extensionJs).toContain('Invalid input: expected ')
      expect(extensionJs).not.toContain('Ungültige Eingabe')
      expect(engineJs).toContain('Ungültige Eingabe')
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

  describe('one copy of the API client’s error classes per bundle', () => {
    // `isAbortError` (utils/errors.ts) recognises the client's abort by `instanceof`. That
    // only works while each bundle holds ONE copy of those classes: an ESM import of
    // '@anthropic-ai/sdk' would add `core/error.mjs` beside `core/error.js`, and a user's
    // Esc would then surface as an API error. Counting markers also fails closed: a
    // minified bundle has none, which fails here instead of passing vacuously.
    const copies = (text: string): number =>
      text.match(/^\/\/ \S*node_modules\/@anthropic-ai\/sdk\/core\/error\.m?js$/gm)?.length ?? 0

    test('extension.js and engine.mjs', () => {
      expect(copies(extensionJs)).toBe(1)
      expect(copies(engineJs)).toBe(1)
    })

    test.if(existsSync(CLI_PATH))('dist/rayu.js', () => {
      expect(copies(readFileSync(CLI_PATH, 'utf8'))).toBe(1)
    })
  })

  describe('VSIX packaging and staging contents', () => {
    test('stages the codicon font, stylesheet and attribution', () => {
      for (const file of ['media/codicon.css', 'media/codicon.ttf', 'media/codicon-NOTICE.txt']) {
        expect(existsSync(join(STAGE_DIR, file)), `${file} was not staged`).toBe(true)
      }
      expect(readFileSync(join(STAGE_DIR, 'media/codicon-NOTICE.txt'), 'utf8'))
        .toContain('Creative Commons Attribution 4.0')
    })

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
      expect(output).toContain('extension/media/sprite-goose.png')
      // VS Code's own icon font, with its CC-BY-4.0 attribution.
      expect(output).toContain('extension/media/codicon.css')
      expect(output).toContain('extension/media/codicon.ttf')
      expect(output).toContain('extension/media/codicon-NOTICE.txt')
      expect(output).toContain('extension/readme.md')
      expect(output).toContain('extension/changelog.md')

      // No map files
      expect(output.includes('.map')).toBe(false)
    })
  })
})

// ── platform VSIX (compiled engine) ──────────────────────────────────────────
//
// Checked for this machine's platform when it has been built
// (`bun run build:vscode --target <platform>`); CI builds and smoke-tests every one.
const PLATFORM_ID = `${process.platform}-${process.arch}`
const PLATFORM_VSIX = join(ROOT, `dist/rayucode-${pkg.version}-${PLATFORM_ID}.vsix`)
const ENGINE_BINARY = `extension/bin/rayucode-engine${process.platform === 'win32' ? '.exe' : ''}`
const RG_BINARY = `extension/bin/rg${process.platform === 'win32' ? '.exe' : ''}`

describe.if(existsSync(PLATFORM_VSIX))(`platform VSIX (${PLATFORM_ID})`, () => {
  const listing = (): string =>
    spawnSync('unzip', ['-l', PLATFORM_VSIX], { encoding: 'utf8' }).stdout

  test('ships the compiled engine instead of engine.mjs, never both', () => {
    const output = listing()
    expect(output).toContain(ENGINE_BINARY)
    expect(output).not.toContain('extension/engine.mjs')
    expect(output).toContain('extension/extension.js')
    expect(output).toContain('extension/media/webview.js')
  })

  test('ships ripgrep beside the engine, so search does not depend on PATH', () => {
    expect(listing()).toContain(RG_BINARY)
  })

  test.skipIf(process.platform === 'win32')('keeps the engine and ripgrep executable', () => {
    // `unzip -Z` (zipinfo) prints the stored POSIX mode first.
    for (const entry of [ENGINE_BINARY, RG_BINARY]) {
      const info = spawnSync('unzip', ['-Z', PLATFORM_VSIX, entry], { encoding: 'utf8' })
      expect(info.status, info.stderr).toBe(0)
      expect(info.stdout.trim()).toMatch(/^-rwxr-xr-x/)
    }
  })

  test('records its platform, so the Marketplace serves it only to matching installs', () => {
    const manifest = spawnSync('unzip', ['-p', PLATFORM_VSIX, 'extension.vsixmanifest'], { encoding: 'utf8' })
    expect(manifest.stdout).toContain(`TargetPlatform="${PLATFORM_ID}"`)
  })
})

describe('extension manifest', () => {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'src/vscode/extension.manifest.json'), 'utf8'),
  ) as {
    activationEvents: string[]
    contributes: {
      configuration: { properties: Record<string, { scope?: string }> }
      commands: Array<{ command: string; icon?: string }>
      menus: Record<string, Array<{ command: string; when?: string; group?: string }>>
      authentication?: Array<{ id: string; label: string }>
    }
  }

  test('the engine override is machine-scoped, so no workspace can redirect it', () => {
    // A workspace-scoped engine path would let any opened folder choose which program
    // the extension runs.
    expect(manifest.contributes.configuration.properties['rayucode.engine.path']?.scope).toBe('machine')
    expect(manifest.contributes.configuration.properties['rayucode.engine.maxMemoryMB']?.scope).toBe('machine')
  })

  test('the Settings tab has a command, a gear in the sidebar title bar and a restore event', () => {
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({ command: 'rayucode.openSettings', icon: '$(gear)' }),
    )
    expect(manifest.contributes.menus['view/title']).toContainEqual({
      command: 'rayucode.openSettings', when: 'view == rayucode.chat', group: 'navigation@2',
    })
    expect(manifest.activationEvents).toContain('onWebviewPanel:rayucode.settings')
  })

  test('contributes the Rayu authentication provider under the same id', () => {
    // The Accounts menu entry: `registerRayuAuthProvider` registers this id at runtime, so
    // the manifest and the code must agree or VS Code never asks for the session.
    expect(manifest.contributes.authentication).toEqual([{ id: 'rayu', label: 'Rayu' }])
  })

  test('activates on the Accounts request and on the Settings command', () => {
    expect(manifest.activationEvents).toContain('onAuthenticationRequest:rayu')
    expect(manifest.activationEvents).toContain('onCommand:rayucode.openSettings')
  })
})
