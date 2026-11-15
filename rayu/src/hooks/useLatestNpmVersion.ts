import { useEffect, useSyncExternalStore } from 'react'
import {
  ensureLatestNpmVersion,
  getCachedLatestNpmVersionSync,
  subscribeLatestNpmVersion,
} from '../utils/autoUpdater.js'

/** Latest published npm version; re-renders the caller when the startup cache lands. */
export function useLatestNpmVersion(): string | null {
  const version = useSyncExternalStore(
    subscribeLatestNpmVersion,
    getCachedLatestNpmVersionSync,
    getCachedLatestNpmVersionSync,
  )
  useEffect(() => {
    void ensureLatestNpmVersion()
  }, [])
  return version
}