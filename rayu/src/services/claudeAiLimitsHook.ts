import { useEffect, useState } from 'react'
import {
  type RayuAILimits,
  currentLimits,
  statusListeners,
} from './claudeAiLimits.js'

export function useRayuAiLimits(): RayuAILimits {
  const [limits, setLimits] = useState<RayuAILimits>({ ...currentLimits })

  useEffect(() => {
    const listener = (newLimits: RayuAILimits) => {
      setLimits({ ...newLimits })
    }
    statusListeners.add(listener)

    return () => {
      statusListeners.delete(listener)
    }
  }, [])

  return limits
}
