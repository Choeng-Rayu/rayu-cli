import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { Goose, GOOSE_ROW_COUNT, type GoosePose } from './Goose.js'

type Frame = { pose: GoosePose; offset: number }

/** Hold a pose for n frames (60ms each) — same cadence as AnimatedClawd. */
function hold(pose: GoosePose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

// Idle cycle: mirrors "row 0, frames 0-6" of a typical pet spritesheet
// (neutral -> dip -> blink -> tilt -> raise -> blink -> neutral), looping
// continuously while mounted. Offset nudges marginTop by 1 during the neck
// dip/raise frames for a subtle bob, same trick AnimatedClawd uses for its
// crouch pose — the container height stays fixed so layout never shifts.
const IDLE_CYCLE: readonly Frame[] = [
  ...hold('idle-0', 0, 10),
  ...hold('idle-1', 1, 6),
  ...hold('idle-2', 1, 4),
  ...hold('idle-3', 0, 8),
  ...hold('idle-4', 0, 6),
  ...hold('idle-5', 0, 4),
  ...hold('idle-6', 0, 10),
]

const FRAME_MS = 60
// +1 row of headroom over the art height so the bounce offset (marginTop 1
// during neck-dip frames) doesn't clip the goose's feet — unlike Clawd's
// intentional "duck below frame" clip, a goose losing its feet every cycle
// would look like a glitch rather than a bob.
const GOOSE_HEIGHT = GOOSE_ROW_COUNT + 1
const incrementFrame = (i: number) => (i + 1) % IDLE_CYCLE.length

/**
 * Goose mascot with a continuously looping idle animation (neck bob +
 * blinks + head tilt). Container height is fixed at GOOSE_HEIGHT so the
 * surrounding layout never shifts as poses cycle. Respects
 * `prefersReducedMotion` by freezing on the first idle frame.
 */
export function AnimatedGoose(): React.ReactNode {
  const { pose, bounceOffset } = useGooseIdleAnimation()
  return (
    <Box height={GOOSE_HEIGHT} flexDirection="column">
      <Box marginTop={bounceOffset} flexShrink={0}>
        <Goose pose={pose} />
      </Box>
    </Box>
  )
}

function useGooseIdleAnimation(): { pose: GoosePose; bounceOffset: number } {
  // Read once at mount — no useSettings() subscription, since that would
  // re-render on any settings change (same pattern as AnimatedClawd).
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )
  const [frameIndex, setFrameIndex] = useState(0)
  const startedRef = useRef(false)

  useEffect(() => {
    if (reducedMotion) return
    // Guard against double-invoke in dev/strict scenarios; harmless either
    // way since setTimeout below is self-cancelling on unmount.
    startedRef.current = true
    const timer = setTimeout(setFrameIndex, FRAME_MS, incrementFrame)
    return () => clearTimeout(timer)
  }, [frameIndex, reducedMotion])

  const current = IDLE_CYCLE[reducedMotion ? 0 : frameIndex]!
  return { pose: current.pose, bounceOffset: current.offset }
}
