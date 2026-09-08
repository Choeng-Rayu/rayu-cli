import { runTests } from '@vscode/test-electron'
import { chromium } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { startLocalProvider } from '../test/helpers/localProvider.js'
import { until } from '../test/helpers/vscodeSession.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const directory = mkdtempSync(join(tmpdir(), 'rayucode-ui-'))
const provider = await startLocalProvider()
const config = join(directory, 'config'), workspace = join(directory, 'workspace')
mkdirSync(config); mkdirSync(workspace)
writeFileSync(join(workspace, 'fixture.txt'), 'before\n')
writeFileSync(join(config, 'providers.json'), JSON.stringify({ activeProvider: 'test', providers: [{ id: 'test', kind: 'openai-compatible', baseURL: provider.url, apiKey: 'fixture-key', defaultModel: 'test-model', fetchedModels: ['test-model', 'test-model-2'] }] }))
// No auto-approval: the UI must actually answer the Edit permission request.
writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read', 'Bash(true)'] } }))
const userData = join(directory, 'user-data'); mkdirSync(join(userData, 'User'), { recursive: true })
writeFileSync(join(userData, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }))
const portServer = createServer(); await new Promise<void>(r => portServer.listen(0, '127.0.0.1', r))
const port = (portServer.address() as AddressInfo).port
await new Promise<void>(r => portServer.close(() => r()))
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
const run = runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? '/usr/share/code/code',
  extensionDevelopmentPath: join(root, 'dist/vscode-stage'),
  extensionTestsPath: join(root, 'test/vscodeUiRunner.cjs'),
  launchArgs: [workspace, '--disable-extensions', '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userData}`, `--extensions-dir=${join(directory, 'extensions')}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
  extensionTestsEnv: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RAYU_CONFIG_DIR: config, USE_RAYU_OAUTH: 'true', RAYU_API_URL: provider.url.replace('/v1', ''), RAYU_GATEWAY_URL: provider.url.replace('/v1', ''), RAYUCODE_UI_CONTROL: directory },
})
// Always observe a launcher failure while the driver waits for readiness.
let launchError: unknown
run.catch(error => { launchError = error })
try {
  await until(() => existsSync(join(directory, 'ready')) || !!launchError, 60_000)
  if (launchError) throw launchError
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser.contexts()[0]!.pages()[0]!
  let frame: ReturnType<typeof page.frames>[number] | undefined
  await until(() => { frame = page.frames().find(f => f.url().includes('vscode-webview') && f.url().includes('fake.html')); return !!frame }, 20_000)
  page.setDefaultTimeout(30_000)
  await frame!.getByRole('button', { name: 'Sign in with Rayu' }).waitFor()
  await frame!.getByRole('button', { name: 'Use an API key instead' }).click()
  await frame!.getByRole('textbox', { name: 'Search providers' }).waitFor()
  await frame!.getByRole('region', { name: 'Connect a provider' }).getByTitle('Close').click()
  writeFileSync(join(config, 'rayu-auth.json'), JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, user: { id: 42, email: 'fixture@example.test', displayName: 'Fixture', avatarUrl: null, role: 'user' } }), { mode: 0o600 })
  const input = frame!.getByRole('textbox', { name: 'Message Rayu' })
  await input.waitFor({ timeout: 20_000 })
  await input.fill('Read fixture.txt, change before to after, run true, then summarize.')
  await frame!.getByTitle('Change model', { exact: true }).click()
  const search = frame!.getByRole('textbox', { name: 'Search models', exact: true })
  await search.fill('New Admin Model')
  await frame!.getByRole('option').filter({ hasText: '123,456 tokens' }).waitFor()
  const hosted = await frame!.getByRole('option').innerText()
  if (!hosted.includes('Images: yes') || !hosted.includes('Thinking: yes') || !hosted.includes('Tools: yes')) throw new Error('Hosted capabilities were lost in the panel')
  await frame!.getByRole('option').click()
  await frame!.getByRole('button', { name: 'Thinking', exact: true }).waitFor()
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('admin-text-only')
  await frame!.getByRole('option').click()
  await frame!.getByRole('button', { name: 'Thinking', exact: true }).waitFor({ state: 'hidden' })
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('test-model-2')
  await search.press('ArrowDown'); await search.press('Enter')
  if (await input.inputValue() !== 'Read fixture.txt, change before to after, run true, then summarize.') throw new Error('Model selection overwrote the draft')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  await until(() => provider.requests.length > 0, 90_000)
  // Save DOM and screenshots even on failure to make UI regressions reviewable.
  const allow = frame!.getByRole('button', { name: 'Allow once', exact: true })
  await allow.waitFor({ timeout: 45_000 }); await allow.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor({ timeout: 45_000 })
  const output = join(root, 'dist/test-results'); mkdirSync(output, { recursive: true })
  await page.screenshot({ path: join(output, 'rayucode-dark.png') })
  await frame!.getByRole('button', { name: 'Diff', exact: true }).first().click()
  let actionId = 0
  async function native(action: string, extra: object = {}) {
    const id = ++actionId
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ id, action, ...extra }))
    await until(() => existsSync(join(directory, `response-${id}.json`)), 15_000)
    const response = JSON.parse(readFileSync(join(directory, `response-${id}.json`), 'utf8'))
    if (response.error) throw new Error(response.error)
    return response
  }
  const diff = await native('diff')
  if (diff.before !== 'before\n' || diff.after !== 'after\n') throw new Error('Review diff does not match the recorded edit')
  await native('theme', { theme: 'Default Light Modern' })
  await frame!.locator('body.vscode-light').waitFor()
  await page.screenshot({ path: join(output, 'rayucode-light.png') })
  await frame!.getByTitle('Previous sessions', { exact: true }).click()
  await frame!.getByRole('textbox', { name: 'Search previous sessions' }).fill('fixture')
  const history = frame!.getByRole('option').first()
  await history.waitFor(); await history.click(); await history.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor()
  if (provider.requests.filter(r => r.stream).length !== 4) throw new Error('Restoring history resubmitted inference')
  console.log('PASS: real extension host, sign-in gate, hosted catalog/capabilities, keyboard model selection/draft, streaming, approval, exact diff, history, dark/light themes')
} catch (error) {
  if (existsSync(join(directory, 'runner.log'))) {
    console.error('RUNNER LOG:\n' + readFileSync(join(directory, 'runner.log'), 'utf8'))
  }
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) {
      mkdirSync(join(root, 'dist/test-results'), { recursive: true })
      await page.screenshot({ path: join(root, 'dist/test-results/rayucode-failure.png') })
      for (const frame of page.frames()) console.error('FRAME', frame.url(), (await frame.locator('body').innerText().catch(() => '')).slice(-6000))
    }
  }
  throw error
} finally {
  writeFileSync(join(directory, 'done'), 'done')
  await browser?.close()
  await run
  await provider.close()
  rmSync(directory, { recursive: true, force: true })
}
