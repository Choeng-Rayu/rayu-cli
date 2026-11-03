// Past tense verbs for turn completion messages
// These verbs work naturally with "for [duration]" (e.g., "Worked for 5s")
export const TURN_COMPLETION_VERBS = [
  'Baked',
  'Brewed',
  'Churned',
  'Cogitated',
  'Cooked',
  'Crunched',
  'Sautéed',
  'Worked',
]

/**
 * Shortest turn that still gets a "Rayu worked for Ns" completion line.
 *
 * The line used to require >30s, so almost every turn ended with no completion
 * status at all and the user had no consistent signal that the response was
 * finished. It now shows on essentially every turn — but not on instant ones: a
 * sub-second turn would render "worked for 0s" (formatDuration floors to whole
 * seconds under a minute), which reads like a bug. 1000ms is therefore both the
 * threshold and the guarantee that the rendered value is at least "1s".
 */
export const MIN_TURN_DURATION_MS = 1000
