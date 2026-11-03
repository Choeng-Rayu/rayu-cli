/**
 * Publishes this machine's session list so the Telegram Mini App can render it.
 *
 * Run by the BRIDGE LEADER only. The leader is the process that already knows
 * which session is attached, and having every session publish would mean N
 * writers racing on one row for no benefit.
 *
 * THROTTLED, and cheap when nothing changed: the payload is compared against the
 * last one published and skipped if identical. A developer with a session open all
 * day would otherwise generate a write every interval forever, and the Mini App
 * only needs the snapshot to be current, not continuously rewritten.
 */

import {
  publishSessionSnapshot,
  type SnapshotSession,
} from '../services/rayuAuth/rayuDevices.js'
import { hasRayuSession } from '../services/rayuAuth/rayuSession.js'
import { logForDebugging } from '../utils/debug.js'
import { attachedSessionId } from './telegramAttach.js'
import { listSessionViews } from './telegramSessions.js'

/**
 * How often the snapshot is refreshed.
 *
 * Comfortably inside the backend's SNAPSHOT_TTL_MS (3 min), so a live leader's
 * snapshot never ages into "stale" while it is still publishing.
 */
export const SNAPSHOT_INTERVAL_MS = 45_000

let timer: ReturnType<typeof setInterval> | null = null
/** Last payload published, to skip no-op writes. */
let lastSerialized = ''

/**
 * Build the payload.
 *
 * Maps SessionView → SnapshotSession explicitly rather than spreading, so adding
 * a field to SessionView can never silently publish it. That matters because the
 * underlying SessionRecord contains `ipcToken`; SessionView already omits it, and
 * this explicit mapping is the second line of the same defence.
 */
async function buildSnapshot(): Promise<SnapshotSession[]> {
  const views = await listSessionViews(attachedSessionId())
  return views.map(view => ({
    sessionId: view.sessionId,
    title: view.title,
    cwd: view.cwd,
    status: view.status,
    attached: view.isAttached,
    startedAt: view.startedAt,
  }))
}

/** Publish once, skipping the write when nothing changed. */
export async function publishSnapshotNow(): Promise<void> {
  // Hosted only: a BYO-bot user has no Rayu session, so there is no backend to
  // publish to and no Mini App to read it.
  if (!hasRayuSession()) return
  try {
    const sessions = await buildSnapshot()
    const serialized = JSON.stringify(sessions)
    if (serialized === lastSerialized) return
    const ok = await publishSessionSnapshot(sessions)
    // Only remember it on success, so a failed publish retries next tick instead
    // of being suppressed by the equality check.
    if (ok) lastSerialized = serialized
  } catch (e) {
    logForDebugging(
      `[telegram-snapshot] publish failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/** Start periodic publishing. Idempotent. */
export function startSnapshotPublishing(): void {
  if (timer) return
  void publishSnapshotNow()
  timer = setInterval(() => {
    void publishSnapshotNow()
  }, SNAPSHOT_INTERVAL_MS)
  try {
    // Never hold the process open just to publish a snapshot.
    ;(timer as unknown as { unref(): void }).unref()
  } catch {
    // Not available in every runtime.
  }
}

/** Stop publishing (bridge stopped, or handed off to another leader). */
export function stopSnapshotPublishing(): void {
  if (timer) clearInterval(timer)
  timer = null
  // Clear the cache so the next leader publishes immediately rather than
  // assuming its first payload is already live.
  lastSerialized = ''
}
