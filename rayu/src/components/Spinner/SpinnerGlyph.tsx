import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { type Theme } from '../../utils/theme.js'
import { interpolateColor, toRGBColor } from './utils.js'

// Animated dot-matrix loading glyph — the terminal rendering of the Claude-style
// pulsing-dots loader (reference SVG, --dur 1.2s). A single braille cell that
// "breathes": it fills from one dot out to a full 8-dot cell and back. One frame
// advances per ~120ms, so 10 frames ≈ a 1.2s cycle (matching the SVG).
const PULSE = ['\u2801', '\u2807', '\u2837', '\u287F', '\u28FF'] // ⠁ ⠇ ⠷ ⡿ ⣿
const SPINNER_FRAMES = [...PULSE, ...[...PULSE].reverse()]

// The reference icon's lit-dot color (SVG `--on: #F5F5F5`). Tuned for the dark
// terminals these CLIs target; ink degrades hex to the nearest ANSI elsewhere.
const ICON_COLOR = '#a46565'
const ICON_RGB = { r: 245, g: 245, b: 245 }
const ERROR_RED = { r: 171, g: 43, b: 63 }

const REDUCED_MOTION_DOT = '\u28FF' // ⣿ — a steady full dot-cell
const REDUCED_MOTION_CYCLE_MS = 2000 // 2s cycle: 1s bright, 1s dim

type Props = {
  frame: number
  messageColor: keyof Theme
  stalledIntensity?: number
  reducedMotion?: boolean
  time?: number
}

export function SpinnerGlyph({
  frame,
  // The glyph uses the fixed icon color; messageColor styles the message text.
  messageColor: _messageColor,
  stalledIntensity = 0,
  reducedMotion = false,
  time = 0,
}: Props): React.ReactNode {
  // Reduced motion: a steady dot-cell that slowly pulses bright/dim.
  if (reducedMotion) {
    const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1
    return (
      <Box flexWrap="wrap" height={1} width={2}>
        <Text color={ICON_COLOR} dimColor={isDim}>
          {REDUCED_MOTION_DOT}
        </Text>
      </Box>
    )
  }

  const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]

  // Smoothly interpolate the icon color toward red while the turn is stalled.
  const color =
    stalledIntensity > 0
      ? toRGBColor(interpolateColor(ICON_RGB, ERROR_RED, stalledIntensity))
      : ICON_COLOR

  return (
    <Box flexWrap="wrap" height={1} width={2}>
      <Text color={color}>{spinnerChar}</Text>
    </Box>
  )
}

























// old claude code icon display style
// ** Don't touch this! ** The "SpinnerGlyph" component is the result of a very careful and delicate optimization process. It is not intended to be read or modified by humans, and any changes to it may cause it to break in subtle and unpredictable ways. If you need to make changes to the spinner, please do so in the original source code and then re-run the optimization process to generate a new version of this file. Thank you for your understanding.

// import { c as _c } from "react/compiler-runtime";
// import * as React from 'react';
// import { Box, Text, useTheme } from '../../ink.js';
// import { getTheme, type Theme } from '../../utils/theme.js';
// import { getDefaultCharacters, interpolateColor, parseRGB, toRGBColor } from './utils.js';
// const DEFAULT_CHARACTERS = getDefaultCharacters();
// const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];
// const REDUCED_MOTION_DOT = '●';
// const REDUCED_MOTION_CYCLE_MS = 2000; // 2-second cycle: 1s visible, 1s dim
// const ERROR_RED = {
//   r: 171,
//   g: 43,
//   b: 63
// };
// type Props = {
//   frame: number;
//   messageColor: keyof Theme;
//   stalledIntensity?: number;
//   reducedMotion?: boolean;
//   time?: number;
// };
// export function SpinnerGlyph(t0) {
//   const $ = _c(9);
//   const {
//     frame,
//     messageColor,
//     stalledIntensity: t1,
//     reducedMotion: t2,
//     time: t3
//   } = t0;
//   const stalledIntensity = t1 === undefined ? 0 : t1;
//   const reducedMotion = t2 === undefined ? false : t2;
//   const time = t3 === undefined ? 0 : t3;
//   const [themeName] = useTheme();
//   const theme = getTheme(themeName);
//   if (reducedMotion) {
//     const isDim = Math.floor(time / (REDUCED_MOTION_CYCLE_MS / 2)) % 2 === 1;
//     let t4;
//     if ($[0] !== isDim || $[1] !== messageColor) {
//       t4 = <Box flexWrap="wrap" height={1} width={2}><Text color={messageColor} dimColor={isDim}>{REDUCED_MOTION_DOT}</Text></Box>;
//       $[0] = isDim;
//       $[1] = messageColor;
//       $[2] = t4;
//     } else {
//       t4 = $[2];
//     }
//     return t4;
//   }
//   const spinnerChar = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
//   if (stalledIntensity > 0) {
//     const baseColorStr = theme[messageColor];
//     const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
//     if (baseRGB) {
//       const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
//       return <Box flexWrap="wrap" height={1} width={2}><Text color={toRGBColor(interpolated)}>{spinnerChar}</Text></Box>;
//     }
//     const color = stalledIntensity > 0.5 ? "error" : messageColor;
//     let t4;
//     if ($[3] !== color || $[4] !== spinnerChar) {
//       t4 = <Box flexWrap="wrap" height={1} width={2}><Text color={color}>{spinnerChar}</Text></Box>;
//       $[3] = color;
//       $[4] = spinnerChar;
//       $[5] = t4;
//     } else {
//       t4 = $[5];
//     }
//     return t4;
//   }
//   let t4;
//   if ($[6] !== messageColor || $[7] !== spinnerChar) {
//     t4 = <Box flexWrap="wrap" height={1} width={2}><Text color={messageColor}>{spinnerChar}</Text></Box>;
//     $[6] = messageColor;
//     $[7] = spinnerChar;
//     $[8] = t4;
//   } else {
//     t4 = $[8];
//   }
//   return t4;
// }
