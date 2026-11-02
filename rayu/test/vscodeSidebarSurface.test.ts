/**
 * The sidebar's own conversation slot, and the two pure decisions behind it.
 *
 * The sidebar hosts the first conversation as a full chat instead of duplicating it as an
 * editor tab. That makes the registry's `sidebarKey` a second binding alongside the active
 * one, with rules that are easy to get subtly wrong and invisible when they are:
 *
 *   - only an explicit `create({ inSidebar: true })` claims an EMPTY slot;
 *   - activating a conversation never moves the binding, so a session opened from the
 *     sidebar cannot silently take it over;
 *   - closing the sidebar's conversation empties the slot and creates NO replacement, so
 *     the sidebar can fall back to its sessions list;
 *   - capacity eviction never retires the sidebar's conversation, because emptying the
 *     sidebar behind the user's back is a visible loss they did not ask for.
 *
 * `routeForSession` and `sidebarBody` are the two pure predicates the host and the webview
 * use to decide where an open conversation belongs and what the sidebar body shows. They
 * import nothing that needs a running engine, so these tests never spawn one: creating a
 * `ChatSession` does not start a child; only `warmup`/`submitPrompt` do, and neither is
 * called here.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_LIVE_SESSIONS,
  SessionRegistry,
  type SessionEntry,
} from '../src/vscode/host/panel/sessionRegistry.js'
import { routeForSession } from '../src/vscode/host/panel/surfaceRouting.js'
import { sidebarBody } from '../src/vscode/webview/state/sidebarBody.js'
import { sessionCallbacks } from './helpers/vscodeSession.js'

const dirs: string[] = []
const registries: SessionRegistry[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayucode-sidebar-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A registry over a never-spawned engine, with the sidebar notifications recorded. */
function makeRegistry(dir: string): {
  registry: SessionRegistry
  sidebarChanges: Array<SessionEntry | null>
} {
  const sidebarChanges: Array<SessionEntry | null> = []
  const registry = new SessionRegistry(
    // Deliberately nonexistent: nothing here warms up or submits, so no child is spawned.
    { enginePath: join(dir, 'engine.mjs'), cwd: dir, nodePath: process.execPath },
    {
      sessionCallbacks: () => sessionCallbacks(),
      onShowPermission: () => {},
      onDismissPermission: () => {},
      onChanged: () => {},
      onActivate: () => {},
      onSidebarChanged: entry => sidebarChanges.push(entry),
    },
  )
  registries.push(registry)
  return { registry, sidebarChanges }
}

test('a bare create() leaves the sidebar slot unclaimed', () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)

  const entry = registry.create()

  // It is an ordinary editor tab: active, but not the sidebar's conversation.
  expect(registry.activeSessionKey).toBe(entry.key)
  expect(registry.hasSidebarSession).toBe(false)
  expect(registry.sidebarSessionKey).toBe('')
  expect(registry.sidebarEntry).toBeNull()
})

test('create({ inSidebar: true }) claims the slot and activate() never moves it', () => {
  const dir = tempDir()
  const { registry, sidebarChanges } = makeRegistry(dir)

  const sidebar = registry.create({ inSidebar: true })
  expect(registry.hasSidebarSession).toBe(true)
  expect(registry.sidebarSessionKey).toBe(sidebar.key)
  expect(registry.sidebarEntry).toBe(sidebar)
  expect(sidebarChanges).toHaveLength(1)
  expect(sidebarChanges[0]).toBe(sidebar)

  // A second, bare create() is just another tab: it becomes active but cannot steal the slot.
  const tab = registry.create()
  expect(registry.activeSessionKey).toBe(tab.key)
  expect(registry.sidebarSessionKey).toBe(sidebar.key)

  // Bringing the sidebar's conversation to the front is an activation, not a re-claim.
  registry.activate(sidebar.key)
  expect(registry.activeSessionKey).toBe(sidebar.key)
  expect(registry.sidebarSessionKey).toBe(sidebar.key)
  expect(registry.sidebarEntry).toBe(sidebar)
  expect(sidebarChanges).toHaveLength(1)
})

test('closing the sidebar conversation clears the slot and creates no replacement', () => {
  const dir = tempDir()
  const { registry, sidebarChanges } = makeRegistry(dir)

  const sidebar = registry.create({ inSidebar: true })
  registry.create() // an editor tab, so the close has something left to show
  const before = registry.all.length

  registry.close(sidebar.key)

  expect(registry.sidebarSessionKey).toBe('')
  expect(registry.hasSidebarSession).toBe(false)
  expect(registry.sidebarEntry).toBeNull()
  expect(registry.has(sidebar.key)).toBe(false)
  // Exactly one entry went away: no replacement was created behind the user's back.
  expect(registry.all).toHaveLength(before - 1)
  // The last sidebar notification says the slot is now empty (null), which is what lets the
  // sidebar render its sessions list.
  expect(sidebarChanges.at(-1)).toBeNull()
})

test('capacity eviction never retires the sidebar conversation', () => {
  const dir = tempDir()
  const { registry } = makeRegistry(dir)

  const sidebar = registry.create({ inSidebar: true })
  for (let index = 0; index < MAX_LIVE_SESSIONS + 2; index += 1) registry.create()

  // The cap is exceeded rather than enforced, because the only alternative is emptying the
  // sidebar while the user is looking at it.
  expect(registry.hasSidebarSession).toBe(true)
  expect(registry.sidebarSessionKey).toBe(sidebar.key)
  expect(registry.sidebarEntry).toBe(sidebar)
  expect(registry.all.some(entry => entry.key === sidebar.key)).toBe(true)
})

test('routeForSession routes the sidebar key, adopts into an empty slot, and tabs otherwise', () => {
  // Its own conversation: reveal the sidebar rather than opening a duplicate tab.
  expect(routeForSession('panel-1', 'panel-1')).toBe('sidebar')
  // Nothing hosts the sidebar yet: move this open conversation into it.
  expect(routeForSession('panel-1', '')).toBe('adopt')
  // The sidebar is occupied by someone else: open/focus this one as a tab.
  expect(routeForSession('panel-1', 'panel-2')).toBe('tab')
  // A missing key is never the sidebar's, and an empty slot always adopts.
  expect(routeForSession('', '')).toBe('adopt')
  expect(routeForSession('', 'panel-2')).toBe('tab')
})

test('sidebarBody selects sign-in, sessions or chat', () => {
  // A panel always hosts its conversation, whatever the flags say.
  expect(sidebarBody({ surface: 'panel', signedOut: true, hasConversation: false, view: 'sessions' }))
    .toBe('chat')
  // Sign-in outranks everything on the sidebar.
  expect(sidebarBody({ surface: 'sidebar', signedOut: true, hasConversation: true, view: 'chat' }))
    .toBe('signin')
  // No conversation means the hub body is the sessions list, even if 'chat' was requested.
  expect(sidebarBody({ surface: 'sidebar', signedOut: false, hasConversation: false, view: 'chat' }))
    .toBe('sessions')
  // Hosting a conversation, the view flag picks between its chat and the list.
  expect(sidebarBody({ surface: 'sidebar', signedOut: false, hasConversation: true, view: 'sessions' }))
    .toBe('sessions')
  expect(sidebarBody({ surface: 'sidebar', signedOut: false, hasConversation: true, view: 'chat' }))
    .toBe('chat')
})
