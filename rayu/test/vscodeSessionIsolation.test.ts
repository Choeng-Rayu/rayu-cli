import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Separate processes keep host globals and Bun module mocks out of other suites.
async function runFixture(mode?: 'first-login'): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'rayucode-session-isolation-'))
  try {
    const build = Bun.spawn(['bun', resolve('test/fixtures/build-vscode-isolation.ts'), directory, ...(mode ? [mode] : [])], {
      stdout: 'pipe', stderr: 'pipe',
    })
    const [buildError, buildExit] = await Promise.all([new Response(build.stderr).text(), build.exited])
    expect(buildError).toBe('')
    expect(buildExit).toBe(0)
    const child = Bun.spawn([
      'node', resolve('test/fixtures/vscode-session-isolation.cjs'), join(directory, 'extension.js'), directory,
      ...(mode ? [mode] : []),
    ], { stdout: 'pipe', stderr: 'pipe' })
    const [output, error, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect(`${output}\n${error}`).toContain(mode === 'first-login' ? 'first login checks passed' : 'session isolation checks passed')
    expect(exitCode).toBe(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('session tabs isolate CLI attachments and preserve their revival bindings', () => runFixture(), 30_000)
test('first login, provider preparation and first prompt finish without reloading VS Code',
  () => runFixture('first-login'), 30_000)
