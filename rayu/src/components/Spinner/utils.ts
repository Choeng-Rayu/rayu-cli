import type { RGBColor as RGBColorString } from '../../ink/styles.js'
import type { RGBColor as RGBColorType } from './types.js'

// Loading-spinner pulse styles, selectable via the `spinnerStyle` setting (/brand).
// All glyphs are in widely-supported blocks (mostly Geometric Shapes, same as ●)
// so they render reliably without per-terminal workarounds.
export const SPINNER_STYLES = {
  circles: ['·', '◦', '○', '◎', '◉', '●'],
  diamonds: ['·', '◇', '◈', '◆', '◈', '◇'],
  dots: ['·', '∙', '•', '●', '•', '∙'],
  squares: ['·', '▫', '◻', '◼', '◻', '▫'],
  classic: ['·', '✢', '✳', '✶', '✻', '✽'], // upstream asterisk sweep
} satisfies Record<string, string[]>

export type SpinnerStyle = keyof typeof SPINNER_STYLES
export const DEFAULT_SPINNER_STYLE: SpinnerStyle = 'circles'

export function getDefaultCharacters(): string[] {
  let style: string | undefined
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getInitialSettings } =
      require('../../utils/settings/settings.js') as typeof import('../../utils/settings/settings.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    style = getInitialSettings()?.spinnerStyle
  } catch {
    // settings not ready — use the default style
  }
  return (
    SPINNER_STYLES[(style as SpinnerStyle) || DEFAULT_SPINNER_STYLE] ??
    SPINNER_STYLES[DEFAULT_SPINNER_STYLE]
  )
}

// Interpolate between two RGB colors
export function interpolateColor(
  color1: RGBColorType,
  color2: RGBColorType,
  t: number, // 0 to 1
): RGBColorType {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

// Convert RGB object to rgb() color string for Text component
export function toRGBColor(color: RGBColorType): RGBColorString {
  return `rgb(${color.r},${color.g},${color.b})`
}

// HSL hue (0-360) to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
export function hueToRgb(hue: number): RGBColorType {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColorType | null>()

export function parseRGB(colorStr: string): RGBColorType | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  const result = match
    ? {
        r: parseInt(match[1]!, 10),
        g: parseInt(match[2]!, 10),
        b: parseInt(match[3]!, 10),
      }
    : null
  RGB_CACHE.set(colorStr, result)
  return result
}
