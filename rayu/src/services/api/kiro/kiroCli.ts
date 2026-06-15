// Lazy helpers for the Kiro "Login with Kiro CLI" /connect flow: detect the
// kiro-cli binary, opt-in install it, run `kiro-cli login`, and check whether a
// token has been written. EVERYTHING here uses child_process / the sqlite read
// lazily — this module is imported ONLY from the /connect Kiro flow, never at
// startup, so a machine without kiro-cli is unaffected until the user opts in.
import { spawn } from 'node:child_process'

/** Official Kiro CLI install command (Linux/macOS). */
export const KIRO_CLI_INSTALL_CMD = 'curl -fsSL https://cli.kiro.dev/install | bash'

/** Whether auto-install is supported on this platform (Linux/macOS only). */
export function canAutoInstallKiroCli(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin'
}

/** True if `kiro-cli` is on PATH (resolves quickly; never throws). */
export function checkKiroCli(timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    const finish = (v: boolean) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const p = spawn('kiro-cli', ['--version'], { stdio: 'ignore' })
      p.on('error', () => finish(false))
      p.on('exit', code => finish(code === 0))
      setTimeout(() => {
        try {
          p.kill()
        } catch {
          // ignore
        }
        finish(false)
      }, timeoutMs)
    } catch {
      finish(false)
    }
  })
}

/** Run the official install script (opt-in). Resolves with combined output. */
export function installKiroCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    if (!canAutoInstallKiroCli()) {
      resolve({
        ok: false,
        output: 'Auto-install is only supported on Linux/macOS. Install kiro-cli manually from https://kiro.dev/downloads/.',
      })
      return
    }
    let output = ''
    let done = false
    const finish = (ok: boolean) => {
      if (!done) {
        done = true
        resolve({ ok, output })
      }
    }
    try {
      const p = spawn('bash', ['-c', KIRO_CLI_INSTALL_CMD], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      p.stdout?.on('data', d => (output += String(d)))
      p.stderr?.on('data', d => (output += String(d)))
      p.on('error', e => {
        output += String(e)
        finish(false)
      })
      p.on('exit', code => finish(code === 0))
    } catch (e) {
      output += String(e)
      finish(false)
    }
  })
}

/**
 * Run `kiro-cli login`. It opens a browser (or prints a device URL/code, which
 * we surface via the captured output) and waits for the auth to complete, then
 * writes the token to the sqlite DB and exits. stdio is piped (not inherited) so
 * it does not fight the Ink TUI for the terminal.
 */
export function launchKiroLogin(
  onOutput?: (chunk: string) => void,
): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    let output = ''
    let done = false
    const finish = (ok: boolean) => {
      if (!done) {
        done = true
        resolve({ ok, output })
      }
    }
    try {
      const p = spawn('kiro-cli', ['login'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const onData = (d: unknown) => {
        const s = String(d)
        output += s
        onOutput?.(s)
      }
      p.stdout?.on('data', onData)
      p.stderr?.on('data', onData)
      p.on('error', e => {
        output += String(e)
        finish(false)
      })
      p.on('exit', code => finish(code === 0))
    } catch (e) {
      output += String(e)
      finish(false)
    }
  })
}

/** True if a usable Kiro token is already present in the kiro-cli DB. */
export async function hasKiroToken(): Promise<boolean> {
  try {
    const { readKiroCredentials } = await import('./kiroAuth.js')
    const creds = await readKiroCredentials()
    return !!creds.accessToken
  } catch {
    return false
  }
}
