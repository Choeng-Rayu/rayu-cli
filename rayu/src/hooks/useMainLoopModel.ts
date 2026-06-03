import { useEffect, useReducer } from 'react'
import { onGrowthBookRefresh } from '../services/analytics/growthbook.js'
import { useAppState } from '../state/AppState.js'
import {
  getDefaultMainLoopModelSetting,
  isAnthropicOnlyModelSetting,
  type ModelName,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { isOpenAICompatibleActive } from '../utils/model/providers.js'
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

  // Subscribe to remote (Telegram) model overrides using the same
  // useEffect+useReducer pattern as the GrowthBook refresh below.
  // When setRemoteModelOverride() is called, the signal fires forceRerenderModel,
  // React re-renders this hook, and getRemoteModelOverride() returns the new value.
  // This is more reliable than useSyncExternalStore for fire-and-forget signals.
  const [, forceRerenderModel] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribeToRemoteModelOverride(forceRerenderModel), [])

  // parseUserSpecifiedModel reads tengu_ant_model_override via
  // _CACHED_MAY_BE_STALE (in resolveAntModel). Until GB init completes,
  // that's the stale disk cache; after, it's the in-memory remoteEval map.
  // AppState doesn't change when GB init finishes, so we subscribe to the
  // refresh signal and force a re-render to re-resolve with fresh values.
  const [, forceRerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => onGrowthBookRefresh(forceRerender), [])

  const modelSetting = (
    mainLoopModelForSession ??
    getRemoteModelOverride() ??   // Telegram/remote model change (wins over mainLoopModel)
    mainLoopModel ??
    getDefaultMainLoopModelSetting()
  ) as ModelName
  const model = parseUserSpecifiedModel(
    isOpenAICompatibleActive() && isAnthropicOnlyModelSetting(modelSetting)
      ? getDefaultMainLoopModelSetting()
      : modelSetting,
  )
  return model
}
