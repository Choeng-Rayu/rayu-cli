import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getRemoteModelOverride,
  subscribeToRemoteModelOverride,
} from '../utils/remoteModelOverride.js'

// The value of the selector is a full model name that can be used directly in
// API calls. Use this over getMainLoopModel() when the component needs to
// update upon a model config change.
export function useMainLoopModel(): ModelName {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(s => s.mainLoopModelForSession)

  // Subscribe to remote (Telegram) model overrides. When the Telegram bridge
  // calls setRemoteModelOverride(), useSyncExternalStore detects the snapshot
  // change, triggers a re-render, and the next query closure captures the
  // updated model — without requiring any AppState mutation from non-React code.
  const remoteModelOverride = useSyncExternalStore(
    subscribeToRemoteModelOverride,
    getRemoteModelOverride,
    getRemoteModelOverride,
  )

  // parseUserSpecifiedModel reads tengu_ant_model_override via
  // _CACHED_MAY_BE_STALE (in resolveAntModel). Until GB init completes,
  // that's the stale disk cache; after, it's the in-memory remoteEval map.
  // AppState doesn't change when GB init finishes, so we subscribe to the
  // refresh signal and force a re-render to re-resolve with fresh values.
  // Without this, the alias resolution is frozen until something else
  // happens to re-render the component — the API would sample one model
  // while /model (which also re-resolves) displays another.
  const [, forceRerender] = useReducer(x => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  const model = parseUserSpecifiedModel(
    mainLoopModelForSession ??
      remoteModelOverride ??      // Telegram/remote model change (wins over mainLoopModel)
      mainLoopModel ??
      getDefaultMainLoopModelSetting(),
  )
  return model
}
