import * as React from 'react'
import { Box, Text } from '../../ink.js'

// Original ASCII-art goose mascot. Poses are hand-drawn line art (not a
// copy of any third-party spritesheet/fan-art) so the same idle-cycle
// scaffold used by AnimatedClawd.tsx can drive a goose instead of Clawd.
//
// Each pose is the same 5-row height (round head, eye/beak, neck, body,
// two feet) so swapping poses never shifts surrounding layout — only the
// glyphs inside change (neck dip, blink, head tilt), mirroring how
// AnimatedClawd reuses a fixed-height container for its own pose swaps.
export type GoosePose =
  | 'idle-0' // neutral, eyes open
  | 'idle-1' // neck dips slightly
  | 'idle-2' // blink
  | 'idle-3' // head tilt left
  | 'idle-4' // neck raises slightly
  | 'idle-5' // blink
  | 'idle-6' // back to neutral

export const GOOSE_ROW_COUNT = 5

type GooseArt = readonly [string, string, string, string, string]

const GOOSE_BODY_COLOR = '#f5f5f0' // off-white feathers

const POSES: Record<GoosePose, GooseArt> = {
  'idle-0': ['   __', '  /  \\', ' | o >', '  \\__/\\____', '  (_)   (_)'],
  'idle-1': ['', '   __', '  ( o >', '  \\_/\\_____', '  (_)   (_)'],
  'idle-2': ['   __', '  /  \\', ' | - >', '  \\__/\\____', '  (_)   (_)'],
  'idle-3': ['  __', ' /  \\', '| o >', ' \\__/\\____ ', ' (_)   (_) '],
  'idle-4': ['   __', '  /  \\', '  | o >', '   \\__/\\____', '   (_)   (_)'],
  'idle-5': ['   __', '  /  \\', ' | - >', '  \\__/\\____', '  (_)   (_)'],
  'idle-6': ['   __', '  /  \\', ' | o >', '  \\__/\\____', '  (_)   (_)'],
}

export function Goose({ pose = 'idle-0' }: { pose?: GoosePose } = {}): React.ReactNode {
  const rows = POSES[pose]
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={i} color={GOOSE_BODY_COLOR}>
          {row}
        </Text>
      ))}
    </Box>
  )
}
