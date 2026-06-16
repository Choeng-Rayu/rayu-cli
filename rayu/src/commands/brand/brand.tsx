import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { Select } from '../../components/CustomSelect/index.js'
import {
  DEFAULT_SPINNER_STYLE,
  SPINNER_STYLES,
} from '../../components/Spinner/utils.js'
import { DEFAULT_BRAND_GLYPH } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

// Reliable, distinct-from-upstream brand marks (Geometric Shapes / Misc Symbols
// blocks render where ● renders).
const GLYPH_OPTIONS = ['◈', '◆', '◇', '★', '✦', '❖', '●']

/**
 * /brand — pick the brand mark glyph (status/thinking lines + logo) and the
 * loading-spinner pulse style. Saved to userSettings; applies on restart.
 */
function BrandSetup({ onDone }: { onDone: OnDone }): React.ReactNode {
  const current = getInitialSettings()?.brandGlyph
  const [glyph, setGlyph] = React.useState<string>(
    typeof current === 'string' && current.trim().length > 0
      ? current
      : DEFAULT_BRAND_GLYPH,
  )
  const [step, setStep] = React.useState<'glyph' | 'spinner'>('glyph')

  if (step === 'glyph') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>Brand mark</Text>
        <Text dimColor>
          The glyph shown on status / thinking lines and the logo (current:{' '}
          {glyph}).
        </Text>
        <Select
          options={GLYPH_OPTIONS.map(g => ({
            label: `${g}    ${g} Thinking…    ${g} Conversation compacted`,
            value: g,
          }))}
          onChange={(v: string) => {
            setGlyph(v)
            setStep('spinner')
          }}
          onCancel={() => onDone()}
        />
      </Box>
    )
  }

  const styleKeys = Object.keys(SPINNER_STYLES) as Array<
    keyof typeof SPINNER_STYLES
  >
  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>Loading spinner</Text>
      <Text dimColor>
        Brand mark → {glyph}. Pick the loading pulse (default{' '}
        {DEFAULT_SPINNER_STYLE}).
      </Text>
      <Select
        options={styleKeys.map(k => ({
          label: `${k.padEnd(9)} ${SPINNER_STYLES[k].join(' ')}`,
          value: k,
        }))}
        onChange={(style: string) => {
          updateSettingsForSource('userSettings', {
            brandGlyph: glyph,
            spinnerStyle: style as keyof typeof SPINNER_STYLES,
          })
          onDone(
            `Brand mark → ${glyph}, spinner → ${style}. Restart Rayu to apply everywhere.`,
          )
        }}
        onCancel={() => {
          // Save the glyph even if the spinner step is skipped.
          updateSettingsForSource('userSettings', { brandGlyph: glyph })
          onDone(`Brand mark → ${glyph}. Restart Rayu to apply everywhere.`)
        }}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async onDone => {
  return <BrandSetup onDone={onDone} />
}
