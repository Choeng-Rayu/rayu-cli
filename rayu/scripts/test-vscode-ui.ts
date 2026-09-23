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
writeFileSync(join(config, 'rayu-auth.json'), JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, user: { id: 42, email: 'fixture@example.test', displayName: 'Fixture', avatarUrl: null, role: 'user' } }), { mode: 0o600 })
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
  extensionTestsEnv: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, RAYU_CONFIG_DIR: config, RAYUCODE_AUTH_CONFIG_DIR: config, USE_RAYU_OAUTH: 'true', RAYU_API_URL: provider.url.replace('/v1', ''), RAYU_GATEWAY_URL: provider.url.replace('/v1', ''), RAYUCODE_UI_CONTROL: directory },
})
// Always observe a launcher failure while the driver waits for readiness.
let launchError: unknown
run.catch(error => { launchError = error })
try {
  // Connect before the extension creates its webview. VS Code hosts webviews in
  // out-of-process targets, and attaching after creation is unreliable on recent
  // Electron builds even while the panel is visibly rendered.
  const connectDeadline = Date.now() + 60_000
  while (!browser && Date.now() < connectDeadline) {
    if (launchError) throw launchError
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (!browser) throw new Error('Timed out connecting to VS Code debugging port')
  writeFileSync(join(directory, 'driver-ready'), 'ready')
  await until(() => existsSync(join(directory, 'ready')) || !!launchError, 60_000)
  if (launchError) throw launchError
  const page = browser.contexts()[0]!.pages()[0]!
  page.setDefaultTimeout(30_000)
  // VS Code may expose a webview frame as `vscode-webview://.../fake.html` or as
  // an anonymous out-of-process iframe. Locate our frame by its accessible composer
  // instead of coupling the test to that editor-internal URL.
  async function findRayucodeFrame(timeout = 30_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      for (const candidatePage of browser!.contexts().flatMap(context => context.pages())) {
        for (const candidate of candidatePage.frames()) {
          const count = await candidate
            .getByRole('textbox', { name: 'Message Rayu' })
            .count()
            .catch(() => 0)
          if (count > 0) return candidate
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Timed out waiting for the Rayucode webview')
  }
  let frame = await findRayucodeFrame()
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
  await frame!.getByRole('button', { name: /^Effort:/ }).waitFor()
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('admin-text-only')
  await frame!.getByRole('option').click()
  await frame!.getByRole('button', { name: /^Effort:/ }).waitFor({ state: 'hidden' })
  await frame!.getByTitle('Change model', { exact: true }).click()
  await search.fill('test-model-2')
  await search.press('ArrowDown'); await search.press('Enter')
  if (await input.inputValue() !== 'Read fixture.txt, change before to after, run true, then summarize.') throw new Error('Model selection overwrote the draft')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  // The running state is posted synchronously when the host accepts a prompt. It
  // therefore covers both a still-finishing prewarm and ordinary provider work,
  // rather than leaving the first turn looking frozen.
  //
  // Matched on the STABLE phase wording, not a rotating verb. The panel used to pick a random
  // present-tense verb per turn ("Rayu's Cooking…"), which said the same thing whether the
  // engine was waiting on a provider, editing a file, or blocked on an approval. The phases
  // below are derived from the engine's own stream events, so this assertion also proves the
  // progress projection is wired end to end.
  await frame!
    .getByRole('status')
    .getByText(/^(Starting Rayu|Sending request|Thinking|Responding|Reading|Searching|Editing|Running tool|Waiting for approval)\b/)
    .first()
    .waitFor()
  await until(() => provider.requests.length > 0, 90_000)
  // Save DOM and screenshots even on failure to make UI regressions reviewable.
  const allow = frame!.getByRole('button', { name: 'Allow once', exact: true })
  await allow.waitFor({ timeout: 45_000 }); await allow.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor({ timeout: 45_000 })

  await input.fill('Ask me which file format to use, then confirm my answer.')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  const question = frame!.getByRole('dialog', { name: "Answer Rayu's questions" })
  await question.waitFor({ timeout: 45_000 })
  await question.getByLabel('Text files (.txt)').check()
  await question.getByRole('button', { name: 'Submit answers' }).click()
  await frame!.getByText("You answered Rayu's questions", { exact: true }).waitFor()
  await frame!.getByText('I received your file-format choice.', { exact: true }).waitFor({ timeout: 45_000 })
  if (await frame!.locator('.rc-tool-name').getByText('AskUserQuestion', { exact: true }).count()) {
    throw new Error('AskUserQuestion exposed raw parameters instead of the question form')
  }
  const visibleHeaders = await frame!.locator('.rc-header').count()
  if (visibleHeaders !== 1) {
    const headerShape = await frame!.evaluate(() => ({
      rootChildren: Array.from(document.querySelector('#root')!.children).map(node => ({ tag: node.tagName, className: node.className })),
      headers: Array.from(document.querySelectorAll('.rc-header')).map(node => ({
        parentClass: node.parentElement?.className,
        title: node.querySelector('.rc-header-title')?.textContent,
      })),
      scripts: document.scripts.length,
    }))
    throw new Error(`Expected one chat header, found ${visibleHeaders}: ${JSON.stringify(headerShape)}`)
  }
  const rayucodeFrames: Array<{ url: string; headers: number }> = []
  for (const candidatePage of browser!.contexts().flatMap(context => context.pages())) {
    for (const candidate of candidatePage.frames()) {
      const headers = await candidate.locator('.rc-header').count().catch(() => 0)
      if (headers) rayucodeFrames.push({ url: candidate.url(), headers })
    }
  }
  if (rayucodeFrames.length !== 1) throw new Error(`Expected one Rayucode webview, found ${JSON.stringify(rayucodeFrames)}`)
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
  // ── DROP HANDLING ──────────────────────────────────────────────────────────────
  //
  // Driven with a real `DataTransfer` through the panel's own listeners, because a NATIVE drag
  // cannot be delivered here: VS Code blanks the webview iframe's `pointer-events` for the
  // duration of any drag that looks like it carries a file, unless Shift is held. That was
  // measured against this very harness — an editor-tab drag reported `pointer-events: none`
  // and produced zero events in the frame, while the same drag with Shift reported `auto`.
  //
  // So what is asserted here is the half we own and can break: reading the workbench's
  // formats, resolving them in the extension host, and inserting the mention. The Shift
  // requirement itself belongs to VS Code and is stated in the panel's own copy.
  await frame!.getByRole('textbox', { name: 'Message Rayu' }).fill('')
  await frame!.evaluate((uri: string) => {
    const transfer = new DataTransfer()
    // Both formats, as an Explorer drag supplies them: the standard one truncated to the first
    // uri, VS Code's internal one carrying the full list.
    transfer.setData('text/uri-list', uri)
    transfer.setData('application/vnd.code.uri-list', uri)
    const init = { dataTransfer: transfer, bubbles: true, cancelable: true }
    document.body.dispatchEvent(new DragEvent('dragenter', init))
    document.body.dispatchEvent(new DragEvent('dragover', init))
    document.body.dispatchEvent(new DragEvent('drop', init))
  }, `file://${workspace}/fixture.txt`)
  // Polled rather than passed to `until`, which takes a SYNCHRONOUS predicate — an async one
  // would return a truthy promise on the first tick and assert nothing at all.
  const dropDeadline = Date.now() + 15_000
  let dropped = ''
  while (Date.now() < dropDeadline) {
    dropped = await frame!.getByRole('textbox', { name: 'Message Rayu' }).inputValue()
    if (dropped === '@fixture.txt') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (dropped !== '@fixture.txt') {
    throw new Error(`A dropped uri-list did not become an @-mention (composer was ${JSON.stringify(dropped)})`)
  }
  await frame!.getByRole('textbox', { name: 'Message Rayu' }).fill('')

  // A PASTED path, which is how the CLI's drag-and-drop actually arrives: dragging onto a
  // terminal produces no drop event, the terminal pastes the path, and `utils/pastedPaths.ts`
  // recovers it. The webview shares that module, so the same gesture works here — and unlike a
  // drag, a paste cannot be intercepted by the workbench.
  await frame!.evaluate((path: string) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', path)
    const textarea = document.querySelector('textarea.rc-composer-input') as HTMLTextAreaElement
    textarea.focus()
    textarea.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  }, `${workspace}/fixture.txt`)
  const pasteDeadline = Date.now() + 15_000
  let pasted = ''
  while (Date.now() < pasteDeadline) {
    pasted = await frame!.getByRole('textbox', { name: 'Message Rayu' }).inputValue()
    if (pasted === '@fixture.txt') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (pasted !== '@fixture.txt') {
    throw new Error(`A pasted path did not become an @-mention (composer was ${JSON.stringify(pasted)})`)
  }
  await frame!.getByRole('textbox', { name: 'Message Rayu' }).fill('')

  // The sessions surface is a real panel: the search is labelled "Search sessions" and rows are
  // buttons grouped by recency rather than listbox options.
  //
  // Resuming is NO LONGER a two-click confirmation, because it is no longer destructive. The
  // session matching this search IS the one on screen, so clicking it ACTIVATES rather than
  // respawning — which is why no further inference may be issued.
  await frame!.getByTitle('Sessions', { exact: true }).click()
  await frame!.getByRole('textbox', { name: 'Search sessions' }).fill('fixture')
  const streamsBeforeSwitch = provider.requests.filter(r => r.stream).length
  const history = frame!.locator('.rc-session-row-history, .rc-session-live-row .rc-session-row').first()
  await history.waitFor(); await history.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor()
  if (provider.requests.filter(r => r.stream).length !== streamsBeforeSwitch) throw new Error('Restoring history resubmitted inference')

  await frame!.getByRole('button', { name: /^Conversation name:/ }).click()
  const renameInput = frame!.getByRole('textbox', { name: 'Conversation name' })
  await renameInput.fill('Canva session check')
  await renameInput.press('Enter')
  await frame!.getByText('Canva session check', { exact: true }).first().waitFor()
  if (await frame!.getByRole('button', { name: /^Rename / }).count()) throw new Error('A separate Rename button remains in the chat UI')
  await frame!.getByRole('button', { name: /^Conversation name:/ }).click()
  await frame!.getByRole('textbox', { name: 'Conversation name' }).fill('Unsaved title')
  await frame!.getByRole('textbox', { name: 'Conversation name' }).press('Escape')
  await frame!.getByRole('button', { name: 'Conversation name: Canva session check. Click to edit' }).waitFor()

  await input.fill('/mcp')
  await frame!.getByRole('button', { name: 'Send message' }).click()
  await frame!.getByRole('tab', { name: /^MCP / }).waitFor()
  await frame!.getByRole('button', { name: 'Refresh connections' }).waitFor()
  const runtimeLayout = await frame!.evaluate(() => {
    const shell = document.querySelector('.rc-shell') as HTMLElement
    shell.style.width = '300px'
    const center = document.querySelector('.rc-runtime-center') as HTMLElement
    const composer = document.querySelector('.rc-composer-card') as HTMLElement
    const transcript = document.querySelector('.rc-main-area') as HTMLElement
    const navigation = document.querySelector('.rc-runtime-tabs') as HTMLElement
    const search = document.querySelector('.rc-runtime-search') as HTMLElement
    const list = document.querySelector('.rc-runtime-list') as HTMLElement
    const result = {
      overflow: center.scrollWidth - center.clientWidth,
      transcriptDisplay: getComputedStyle(transcript).display,
      centerBottom: center.getBoundingClientRect().bottom,
      composerTop: composer.getBoundingClientRect().top,
      navigationHeight: navigation.getBoundingClientRect().height,
      searchHeight: search.getBoundingClientRect().height,
      listTop: list.getBoundingClientRect().top,
      searchBottom: search.getBoundingClientRect().bottom,
    }
    shell.style.width = ''
    return result
  })
  if (runtimeLayout.overflow > 1) throw new Error(`MCP center overflows a 300px sidebar by ${runtimeLayout.overflow}px`)
  if (runtimeLayout.transcriptDisplay !== 'none') throw new Error('Runtime center still squeezes a second chat surface below it')
  if (runtimeLayout.centerBottom > runtimeLayout.composerTop + 1) throw new Error(`Runtime center overlaps the composer: ${JSON.stringify(runtimeLayout)}`)
  if (runtimeLayout.navigationHeight < 24) throw new Error(`Runtime navigation was vertically hidden: ${JSON.stringify(runtimeLayout)}`)
  if (runtimeLayout.searchHeight < 30 || runtimeLayout.listTop < runtimeLayout.searchBottom - 1) throw new Error(`Runtime search overlaps its navigation or results: ${JSON.stringify(runtimeLayout)}`)
  await frame!.getByRole('button', { name: 'Close runtime center' }).click()

  // Background work uses the same fixed-controls/scrolling-results layout. A compact fixture
  // catches the regression without depending on a provider deciding to launch a subagent.
  const taskLayout = await frame!.evaluate(() => {
    const fixture = document.createElement('aside')
    fixture.className = 'rc-task-center'
    fixture.style.cssText = 'position:absolute;left:-10000px;top:0;width:300px;height:180px;min-width:0;max-width:none;'
    fixture.innerHTML = `
      <header class="rc-task-center-head"><strong>Background work</strong><button>×</button></header>
      <div class="rc-task-filters">${['All', 'Active', 'Waiting', 'Completed', 'Failed'].map(label => `<button class="rc-task-filter">${label}</button>`).join('')}</div>
      <div class="rc-task-center-scroll"><div style="height:800px">Task results</div></div>`
    document.querySelector('.rc-shell')!.append(fixture)
    const head = fixture.querySelector('.rc-task-center-head') as HTMLElement
    const filters = fixture.querySelector('.rc-task-filters') as HTMLElement
    const scroll = fixture.querySelector('.rc-task-center-scroll') as HTMLElement
    const result = {
      headHeight: head.getBoundingClientRect().height,
      filterHeight: filters.getBoundingClientRect().height,
      headShrink: getComputedStyle(head).flexShrink,
      filterShrink: getComputedStyle(filters).flexShrink,
      scrollGrow: getComputedStyle(scroll).flexGrow,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    }
    fixture.remove()
    return result
  })
  if (taskLayout.headHeight < 38 || taskLayout.filterHeight < 24) throw new Error(`Background-work controls were vertically hidden: ${JSON.stringify(taskLayout)}`)
  if (taskLayout.headShrink !== '0' || taskLayout.filterShrink !== '0' || taskLayout.scrollGrow !== '1') throw new Error(`Background-work flex layout is unsafe: ${JSON.stringify(taskLayout)}`)
  if (taskLayout.scrollHeight <= taskLayout.clientHeight) throw new Error(`Background-work results do not scroll: ${JSON.stringify(taskLayout)}`)

  // Force a long scrollable chat in the narrow sidebar and leave it mid-transcript.
  // The sessions surface hides this element; returning must restore its reading position.
  await frame!.evaluate(() => {
    const el = document.querySelector('.rc-transcript') as HTMLElement
    el.style.maxHeight = '90px'
    el.style.flex = '0 0 90px'
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  await frame!.evaluate(() => {
    const el = document.querySelector('.rc-transcript') as HTMLElement
    el.scrollTop = 30
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await new Promise(resolve => setTimeout(resolve, 100))
  const beforeNew = await frame!.evaluate(() => (document.querySelector('.rc-transcript') as HTMLElement).scrollTop)
  if (beforeNew < 20) throw new Error('Transcript fixture was not scrollable')

  // ── CONCURRENT SESSIONS ────────────────────────────────────────────────────────
  //
  // The reported bug: pressing + killed the conversation that was on screen, and going back
  // rebuilt it from the session FILE. It must now OPEN a second conversation and leave the
  // first one intact, so switching back is a plain activation with the transcript still there.
  await frame!.getByTitle('New session', { exact: true }).click()
  await frame!.locator('.rc-welcome').waitFor()
  await frame!.getByTitle('Sessions — 2 open', { exact: true }).click()
  await frame!.getByText('Open now', { exact: true }).waitFor()
  const live = frame!.locator('.rc-session-live-row')
  if ((await live.count()) !== 2) throw new Error('Opening a session did not leave the previous one open')
  // The row that is NOT on screen is the original conversation.
  await frame!.locator('.rc-session-live-row .rc-session-row:not(.rc-session-row-active)').first().click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor()
  const restored = await frame!.evaluate(() => {
    const el = document.querySelector('.rc-transcript') as HTMLElement
    return { top: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, style: el.getAttribute('style') }
  })
  if (Math.abs(restored.top - beforeNew) > 5) throw new Error(`Switching sessions lost reading position: ${beforeNew} → ${JSON.stringify(restored)}`)
  if (provider.requests.filter(r => r.stream).length !== streamsBeforeSwitch) throw new Error('Switching sessions resubmitted inference')
  if (await frame!.locator('.rc-header').count() !== 1) throw new Error('Switching sessions duplicated the chat header')

  // Close the live conversation and open it from history again. This is the true first-open
  // resume path: the host loads the transcript asynchronously, and it must land at the newest
  // message rather than leaving the browser at scrollTop 0.
  await frame!.getByTitle('Sessions — 2 open', { exact: true }).click()
  await frame!.getByRole('button', { name: 'Close Canva session check' }).click()
  const historicalSession = frame!.locator('.rc-session-row-history').filter({ hasText: 'Canva session check' })
  await historicalSession.waitFor()
  await historicalSession.click()
  await frame!.getByText('The check passed.', { exact: false }).first().waitFor()
  await frame!.waitForTimeout(150)
  const firstOpenHistory = await frame!.evaluate(() => {
    const el = document.querySelector('.rc-transcript') as HTMLElement
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
  })
  if (firstOpenHistory.max > 5 && firstOpenHistory.max - firstOpenHistory.top > 5) {
    throw new Error(`A first-open history session did not start at its latest message: ${JSON.stringify(firstOpenHistory)}`)
  }

  // A restored history can contain up to 400 variable-height blocks. They must all take part
  // in the first layout; deferred intrinsic placeholders make scrollHeight grow as each new
  // viewport is revealed, so a user has to scroll to the apparent bottom over and over.
  const longHistoryLayout = await frame!.evaluate(async () => {
    const probe = document.createElement('div')
    probe.className = 'rc-transcript'
    probe.style.cssText = 'position:absolute;inset:0 auto auto 0;width:280px;height:160px;opacity:.01;pointer-events:none;z-index:10000;'
    for (let index = 0; index < 400; index += 1) {
      const block = document.createElement('div')
      block.className = 'rc-block'
      block.style.cssText = `height:${50 + (index % 7) * 11}px;flex:0 0 auto;`
      probe.append(block)
    }
    document.querySelector('.rc-shell')!.append(probe)
    const firstBlockStyle = getComputedStyle(probe.firstElementChild!)
    probe.scrollTop = probe.scrollHeight
    await new Promise<void>(resolve => {
      let frames = 0
      const next = (): void => {
        frames += 1
        if (frames >= 12) resolve()
        else requestAnimationFrame(next)
      }
      requestAnimationFrame(next)
    })
    const result = {
      top: probe.scrollTop,
      max: probe.scrollHeight - probe.clientHeight,
      contentVisibility: firstBlockStyle.contentVisibility,
      containIntrinsicBlockSize: firstBlockStyle.containIntrinsicBlockSize,
    }
    probe.remove()
    return result
  })
  if (longHistoryLayout.contentVisibility !== 'visible') {
    throw new Error(`Long history still defers unseen message layout: ${JSON.stringify(longHistoryLayout)}`)
  }
  if (longHistoryLayout.max - longHistoryLayout.top > 1) {
    throw new Error(`Long history bottom moved after initial scroll: ${JSON.stringify(longHistoryLayout)}`)
  }
  console.log('PASS: real extension host, AskUserQuestion answers, sign-in gate, hosted catalog/capabilities, keyboard model selection/draft, streaming, approval, exact diff, concurrent sessions, dark/light themes')
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
