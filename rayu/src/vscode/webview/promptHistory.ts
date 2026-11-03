import type { TranscriptEntry } from '../shared/webviewProtocol.js'

export interface PromptHistoryNavigation {
  /** One-based position in the frozen newest-first history snapshot. */
  index: number
  /** The unfinished input that Arrow Down restores after the newest entry. */
  draft: string
  /** Frozen while navigating, matching the CLI's history cache behavior. */
  entries: string[]
}

export interface PromptHistoryResult {
  navigation: PromptHistoryNavigation | null
  value: string
  cursorOffset: number
}

const IMAGE_MARKER = /^\[Image: .*\]$/

/** Build newest-first reusable prompts from the current/restored conversation. */
export function promptHistoryFromTranscript(
  entries: readonly TranscriptEntry[],
): string[] {
  const prompts: string[] = []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind !== 'prompt') continue
    // The transcript stores image descriptions, not image bytes. Re-inserting those
    // descriptions would pretend the attachment is reusable when it is not.
    const text = entry.text
      .split('\n')
      .filter(line => !IMAGE_MARKER.test(line))
      .join('\n')
      .trim()
    if (text) prompts.push(text)
  }
  return prompts
}

/** The CLI invokes history only when Up cannot move to a previous logical line. */
export function canNavigatePromptHistoryUp(
  value: string,
  cursorOffset: number,
): boolean {
  return !value.slice(0, cursorOffset).includes('\n')
}

/** The CLI invokes history only when Down cannot move to a following logical line. */
export function canNavigatePromptHistoryDown(
  value: string,
  cursorOffset: number,
): boolean {
  return !value.slice(cursorOffset).includes('\n')
}

export function navigatePromptHistoryUp(
  navigation: PromptHistoryNavigation | null,
  currentValue: string,
  availableEntries: readonly string[],
): PromptHistoryResult | null {
  const current = navigation ?? {
    index: 0,
    draft: currentValue,
    entries: [...availableEntries],
  }
  if (current.index >= current.entries.length) return null

  const value = current.entries[current.index]
  if (value === undefined) return null
  return {
    navigation: { ...current, index: current.index + 1 },
    value,
    // CLI Up places the caret at the start of the recalled prompt.
    cursorOffset: 0,
  }
}

export function navigatePromptHistoryDown(
  navigation: PromptHistoryNavigation | null,
): PromptHistoryResult | null {
  if (!navigation || navigation.index <= 0) return null

  if (navigation.index === 1) {
    return {
      navigation: null,
      value: navigation.draft,
      cursorOffset: navigation.draft.length,
    }
  }

  const nextIndex = navigation.index - 1
  const value = navigation.entries[nextIndex - 1]
  if (value === undefined) return null
  return {
    navigation: { ...navigation, index: nextIndex },
    value,
    // CLI Down returns the caret to the end for continued editing.
    cursorOffset: value.length,
  }
}
