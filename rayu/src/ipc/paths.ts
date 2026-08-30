/**
 * Socket/pipe path resolution for local inter-session IPC.
 *
 * The hard constraint is LENGTH. A Unix domain socket address is a
 * `sockaddr_un.sun_path`, which is 104 bytes on macOS/BSD and 108 on Linux —
 * including the NUL terminator. That is easy to exceed by accident: macOS sets
 * TMPDIR to a per-user path like
 * `/var/folders/qh/8k2n1x5d1_1abc0000gn/T/`, and a socket under a
 * `~/.rayu`-style config dir that the user has relocated somewhere deep would
 * blow the limit outright. Exceeding it fails at bind() with a confusing
 * ENAMETOOLONG, so the path is built short and verified.
 *
 * Sockets deliberately do NOT live in the Rayu config dir: that directory is
 * frequently on a synced or networked filesystem (Dropbox, NFS, a container
 * bind-mount) where Unix sockets either don't work or leak stale files between
 * machines. Runtime state belongs in a runtime directory.
 */

import { chmodSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Conservative cap: the smaller of the two platform limits, minus the NUL. */
const MAX_SOCKET_PATH_BYTES = 103

export function isWindowsIpc(): boolean {
  return process.platform === 'win32'
}

/**
 * A stable, non-secret per-user discriminator for the socket directory, so two
 * users on one machine never collide. `getuid` is absent on Windows, where the
 * pipe namespace is global and USERNAME is the available discriminator.
 */
function userDiscriminator(): string {
  const uid = (process.getuid as (() => number) | undefined)?.()
  if (uid !== undefined) return String(uid)
  return (process.env.USERNAME ?? process.env.USER ?? 'user').replace(
    /[^A-Za-z0-9_-]/g,
    '',
  )
}

/**
 * Candidate runtime roots, shortest-viable first.
 *
 * XDG_RUNTIME_DIR is the correct answer on Linux (`/run/user/1000`, tmpfs,
 * cleaned on logout, already 0700 and owned by the user). `/tmp` is the fallback
 * specifically because macOS's TMPDIR is long enough to threaten the limit.
 */
function runtimeRootCandidates(): string[] {
  const roots: string[] = []
  const xdg = process.env.XDG_RUNTIME_DIR?.trim()
  if (xdg) roots.push(xdg)
  roots.push(tmpdir())
  roots.push('/tmp')
  return roots
}

/**
 * Directory holding this user's session sockets, created 0700.
 *
 * Picks the first candidate whose resulting socket path fits inside
 * sun_path. Returns the shortest candidate as a last resort so the caller
 * surfaces a real bind error rather than this function throwing during startup.
 */
export function ipcSocketDir(): string {
  const dirName = `rayu-ipc-${userDiscriminator()}`
  const candidates = runtimeRootCandidates().map(root => join(root, dirName))

  // A representative socket name — pids are at most 7 digits on Linux.
  const probe = 's1234567.sock'
  const fitting =
    candidates.find(
      dir => Buffer.byteLength(join(dir, probe), 'utf8') <= MAX_SOCKET_PATH_BYTES,
    ) ??
    candidates.reduce((shortest, dir) => (dir.length < shortest.length ? dir : shortest))

  ensureDir(fitting)
  return fitting
}

function ensureDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    // `mode` on mkdir is masked by umask and ignored when the directory already
    // exists, so tighten explicitly. POSIX-only: chmod is meaningless on Windows.
    if (!isWindowsIpc()) chmodSync(dir, 0o700)
  } catch {
    // Best effort. A bind failure later is a clearer signal than throwing here,
    // and the in-band token means the directory mode is not the only defence.
  }
}

/**
 * The address a session listens on.
 *
 * Windows named pipes are a flat global namespace (`\\.\pipe\<name>`), not
 * filesystem paths, so the user discriminator goes in the NAME instead of a
 * parent directory. They also carry no restrictive ACL — which is exactly why
 * protocol.ts requires a token on every frame.
 */
export function ipcAddressForPid(pid: number): string {
  if (isWindowsIpc()) {
    return `\\\\.\\pipe\\rayu-ipc-${userDiscriminator()}-${pid}`
  }
  return join(ipcSocketDir(), `s${pid}.sock`)
}

/** True when the address is a filesystem path that may be left behind stale. */
export function isUnlinkableAddress(address: string): boolean {
  return !isWindowsIpc() && address.length > 0
}
