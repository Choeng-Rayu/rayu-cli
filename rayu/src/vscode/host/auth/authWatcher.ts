/**
 * Live sync when the OTHER surface signs in or out.
 *
 * The credential is one file shared with the CLI, so it can change without this
 * process doing anything: the user runs `rayu` in a terminal and types `/login`, or
 * `/logout`. Without a watcher the panel would keep showing a stale sign-in screen
 * until the window was reloaded, and the user would reasonably conclude the
 * extension was broken — they DID sign in, after all.
 *
 * ── WHY THE DIRECTORY IS WATCHED, NOT THE FILE ─────────────────────────────────
 *
 * Two reasons, both of which break a naive `fs.watch(file)`:
 *
 *  1. The file may not exist yet. A never-signed-in user has no
 *     `rayu-auth.json`, and watching a missing path throws ENOENT.
 *  2. `writeFileSync` + `chmodSync` can replace the inode. `fs.watch` on a path
 *     follows the ORIGINAL inode on some platforms, so after the first write the
 *     watch is silently attached to a file nobody will ever touch again — the
 *     watcher stops firing and nothing reports an error.
 *
 * Watching the containing directory and filtering by filename sidesteps both.
 *
 * ── WHY EVENTS ARE DEBOUNCED ───────────────────────────────────────────────────
 *
 * A single logical write produces several events — create, write, chmod — and each
 * would otherwise trigger a full state resync and a webview repaint. Worse, the
 * intermediate reads can catch a partially written file. A short trailing debounce
 * collapses the burst into one read of the settled contents.
 */
import { watch, mkdirSync, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'

import { sessionDirPath, sessionFilePath } from './rayuAuthBridge.js'

/** Long enough to collapse create+write+chmod, short enough to feel immediate. */
const DEBOUNCE_MS = 150

/**
 * Watch the shared session file and call `onChange` when it settles.
 *
 * Never throws: the config directory may not exist yet, and an unwatchable
 * filesystem must degrade to "no live sync" rather than failing activation. The
 * panel still refreshes on its own `ready` handshake in that case.
 */
export function watchSharedSession(onChange: () => void, onProvidersChange?: () => void): { dispose: () => void } {
  const dir = sessionDirPath()
  const target = basename(sessionFilePath())

  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  let providersChanged = false
  let sessionChanged = false
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (providersChanged) onProvidersChange?.()
      if (sessionChanged) onChange()
      providersChanged = false
      sessionChanged = false
    }, DEBOUNCE_MS)
    timer.unref?.()
  }

  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // `filename` is null on some platforms. Treating null as "might be ours" is
      // the safe reading: an extra resync is cheap, a missed sign-in is not.
      if (filename === null || filename === 'providers.json') providersChanged = true
      if (filename === null || filename === target) sessionChanged = true
      if (providersChanged || sessionChanged) fire()
    })
    // A watch error (directory deleted, limit reached) must not take the
    // extension host down with an unhandled 'error' event.
    watcher.on('error', () => {})
  } catch {
    // No live sync available. Not fatal — see the header.
  }

  return {
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
      try {
        watcher?.close()
      } catch {
        // Already closed.
      }
      watcher = null
    },
  }
}
