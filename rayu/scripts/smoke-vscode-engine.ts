#!/usr/bin/env bun
/**
 * Smoke-test a platform VSIX on the machine it is for:
 *
 *   bun run scripts/smoke-vscode-engine.ts dist/rayucode-<v>-<target>.vsix [--container <image>]
 *
 * Checks, in order, the things that can break between a green build and a working
 * install:
 *   1. the package holds `bin/rayucode-engine[.exe]` and `bin/rg[.exe]`, and on POSIX
 *      targets both are stored executable (a VSIX packed on Windows silently loses that);
 *   2. the compiled engine STARTS here and answers a helper request — `--rayucode-connect`
 *      with `{"action":"list"}` must produce a `rayucode_connect_presets` frame. That
 *      loads the engine's config and provider modules, so a missing build define or a
 *      runtime incompatibility fails it;
 *   3. the bundled ripgrep runs.
 *
 * `--container <image>` runs the binaries inside a Docker image (e.g. `alpine:3.20` for
 * the musl builds) while this script stays on the host; `--container-setup <shell>` runs
 * first inside it. Bun's musl runtime links libstdc++ and libgcc, which VS Code's own
 * server needs on Alpine too, so the Alpine smoke test installs them:
 *   --container alpine:3.20 --container-setup "apk add --no-cache libstdc++ libgcc"
 *
 * Self-contained on purpose — no `unzip`, which Windows lacks: the archive is read with
 * fflate, and file modes come from the zip's own central directory.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { unzipSync } from 'fflate'

const TIMEOUT_MS = 90_000

/** Unix permission bits recorded for each entry, from the zip central directory. */
export function zipEntryModes(bytes: Uint8Array): Map<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)')
  const entries = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const modes = new Map<string, number>()
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('corrupt central directory')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const external = view.getUint32(offset + 38, true)
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    modes.set(name, (external >>> 16) & 0o7777)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return modes
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
}

function run(command: string[], options: { input?: string; cwd: string; container?: Container; env: Record<string, string> }): Run {
  const argv = options.container ? containerArgv(command, options.cwd, options.env, options.container) : command
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd,
    env: options.container ? process.env : { ...process.env, ...options.env },
    stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT_MS,
  })
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

interface Container {
  image: string
  /** Shell run before the command, e.g. installing the C++ runtime Bun's musl build links. */
  setup?: string
}

function containerArgv(command: string[], cwd: string, env: Record<string, string>, container: Container): string[] {
  const base = [
    'docker', 'run', '--rm', '-i', '-v', `${cwd}:${cwd}`, '-w', cwd,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    container.image,
  ]
  return container.setup
    ? [...base, 'sh', '-c', `${container.setup} >/dev/null 2>&1 && exec "$@"`, 'sh', ...command]
    : [...base, ...command]
}

function fail(message: string, detail?: Run): never {
  console.error(`✗ ${message}`)
  if (detail) console.error(`${detail.stdout.slice(-1500)}\n${detail.stderr.slice(-1500)}`)
  process.exit(1)
}

/** Extract every entry, restoring POSIX modes, and return the extension root. */
function extract(bytes: Uint8Array, modes: Map<string, number>, into: string): string {
  for (const [name, data] of Object.entries(unzipSync(bytes))) {
    if (name.endsWith('/')) continue
    const path = join(into, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    const mode = modes.get(name) ?? 0
    if (process.platform !== 'win32' && mode) chmodSync(path, mode)
  }
  return join(into, 'extension')
}

function checkPackaged(modes: Map<string, number>, exe: string): void {
  for (const entry of [`extension/bin/rayucode-engine${exe}`, `extension/bin/rg${exe}`]) {
    if (!modes.has(entry)) fail(`${entry} is missing from the package`)
    if (!exe && ((modes.get(entry) ?? 0) & 0o111) === 0) fail(`${entry} is not stored executable`)
  }
  console.log('✓ engine and ripgrep are packaged' + (exe ? '' : ' and executable'))
}

function main(): void {
  const vsixArg = process.argv[2]
  if (!vsixArg) {
    console.error('usage: bun run scripts/smoke-vscode-engine.ts <platform.vsix> [--container <image> [--container-setup <shell>]]')
    process.exit(2)
  }
  const option = (name: string): string | undefined => {
    const at = process.argv.indexOf(name)
    return at > 0 ? process.argv[at + 1] : undefined
  }
  const image = option('--container')
  const container = image ? { image, setup: option('--container-setup') } : undefined
  const bytes = new Uint8Array(readFileSync(resolve(vsixArg)))
  const modes = zipEntryModes(bytes)
  const exe = modes.has('extension/bin/rayucode-engine.exe') ? '.exe' : ''
  checkPackaged(modes, exe)

  const dir = mkdtempSync(join(tmpdir(), 'rayucode-smoke-'))
  try {
    const root = extract(bytes, modes, dir)
    const env = { RAYU_CONFIG_DIR: join(dir, 'config'), USE_RAYU_OAUTH: 'false', NO_COLOR: '1' }
    const connect = run([join(root, `bin/rayucode-engine${exe}`), '--rayucode-connect'], {
      input: '{"action":"list"}', cwd: dir, container, env,
    })
    if (!connect.stdout.includes('"rayucode_connect_presets"')) {
      fail('the compiled engine did not answer a provider-list request', connect)
    }
    console.log('✓ the compiled engine starts and answers a helper request')

    const rg = run([join(root, `bin/rg${exe}`), '--version'], { cwd: dir, container, env })
    if (rg.code !== 0 || !rg.stdout.includes('ripgrep')) fail('the bundled ripgrep did not run', rg)
    console.log(`✓ ${rg.stdout.split('\n')[0]}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) main()
