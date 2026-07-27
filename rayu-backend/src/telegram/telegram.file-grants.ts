/**
 * Short-lived, per-user grants for inbound Telegram file downloads.
 *
 * Why this exists: a Telegram `file_id` is a global handle, and the shared bot
 * has seen the files of every linked user. If the download endpoint accepted any
 * id from any signed-in caller, one user could read another user's images just
 * by holding (or guessing) their id. A grant is recorded only when the update
 * carrying the id is delivered to that specific user, so the endpoint can prove
 * ownership without trusting the caller.
 *
 * In memory on purpose: no schema change, and nothing here is worth persisting —
 * an expired or lost grant just means the user re-sends the image.
 */

const GRANT_TTL_MS = 15 * 60 * 1000
/** Bounded so a flood of media can't grow the map without limit. */
const MAX_GRANTS = 5_000

/** `${userId}:${fileId}` → expiry epoch ms. */
const grants = new Map<string, number>()

function key(userId: number, fileId: string): string {
  return `${userId}:${fileId}`
}

function prune(now: number): void {
  for (const [k, expiry] of grants) {
    if (expiry <= now) grants.delete(k)
  }
  if (grants.size <= MAX_GRANTS) return
  // Still over budget — drop oldest insertions first (Map preserves order).
  const excess = grants.size - MAX_GRANTS
  let dropped = 0
  for (const k of grants.keys()) {
    grants.delete(k)
    if (++dropped >= excess) break
  }
}

export function grantFileIds(userId: number, fileIds: readonly string[]): void {
  if (fileIds.length === 0) return
  const now = Date.now()
  prune(now)
  for (const fileId of fileIds) {
    grants.set(key(userId, fileId), now + GRANT_TTL_MS)
  }
}

export function hasFileGrant(userId: number, fileId: string): boolean {
  const expiry = grants.get(key(userId, fileId))
  if (expiry === undefined) return false
  if (expiry <= Date.now()) {
    grants.delete(key(userId, fileId))
    return false
  }
  return true
}

/** Test helper. */
export function resetFileGrants(): void {
  grants.clear()
}
