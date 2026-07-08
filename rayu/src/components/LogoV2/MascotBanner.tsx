import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box } from '../../ink.js'
import { Ansi } from '../../ink/Ansi.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getGlobalConfig } from '../../utils/config.js'
import { renderMascotBanner } from '../../utils/mascotBanner.js'
import { stringWidth } from '../../ink/stringWidth.js'

/**
 * Renders the startup mascot banner exactly once and never redraws it —
 * matching Claude Code's own banner behavior. The expensive work (terminal
 * capability detection, image resize/encode or Unicode block-art
 * generation, on-disk cache read/write) all happens inside
 * `renderMascotBanner()`, called exactly once per mount.
 *
 * Once the banner data resolves, it is stored in state and never touched
 * again — no polling, no interval, no animation loop. The rendered banner
 * never changes for the lifetime of the session, matching the "print once,
 * never redraw" requirement.
 */
export function MascotBanner(): React.ReactNode {
  const enabled = getGlobalConfig().mascotBannerEnabled
  const { columns } = useTerminalSize()
  const [output, setOutput] = useState<string | null>(null)
  const [protocol, setProtocol] = useState<'kitty' | 'iterm2' | 'none' | null>(
    null,
  )

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void renderMascotBanner().then(result => {
      if (cancelled) return
      setOutput(result.output)
      setProtocol(result.usedProtocol)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only fetch
  }, [])

  if (!enabled || output === null) return null

  if (protocol === 'kitty') {
    // Kitty Graphics Protocol APC sequences (ESC _G ... ESC \) must reach
    // the terminal byte-for-byte — Ansi's termio parser is built for SGR
    // color/style codes, not this distinct escape mechanism, so it's
    // written directly to stdout instead of passed through Ink's Text tree.
    return (
      <Box marginY={1}>
        <RawEscapeSequence sequence={output} />
      </Box>
    )
  }

  // iTerm2's OSC 1337 sequence and the Unicode block-art fallback are both
  // genuinely ANSI-colored text content, so Ansi's parser (which already
  // handles SGR 24-bit color merging) renders them correctly.
  const lines = output.split('\n')
  const maxLineWidth = Math.max(...lines.map(line => stringWidth(line)))
  const leftPad = Math.max(0, Math.floor((columns - maxLineWidth) / 2))

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={leftPad}>
      <Ansi>{output}</Ansi>
    </Box>
  )
}

/** Writes a raw escape sequence to stdout without any Ink text processing.
 *  Runs exactly once on mount — no dependency changes trigger a rewrite. */
function RawEscapeSequence({ sequence }: { sequence: string }): React.ReactNode {
  useEffect(() => {
    process.stdout.write(sequence)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- write once on mount only
  }, [])
  return null
}
