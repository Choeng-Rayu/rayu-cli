import { describe, expect, test } from 'bun:test'

import type { TranscriptEntry } from '../src/vscode/shared/webviewProtocol.js'
import {
  canNavigatePromptHistoryDown,
  canNavigatePromptHistoryUp,
  navigatePromptHistoryDown,
  navigatePromptHistoryUp,
  promptHistoryFromTranscript,
} from '../src/vscode/webview/promptHistory.js'

describe('VS Code prompt history', () => {
  test('extracts prompts newest-first and does not fake reusable image attachments', () => {
    const entries: TranscriptEntry[] = [
      { id: 'p1', kind: 'prompt', text: 'first prompt' },
      { id: 'a1', kind: 'assistant', text: 'answer' },
      {
        id: 'p2',
        kind: 'prompt',
        text: 'inspect this\n[Image: screenshot.png]',
      },
      { id: 'p3', kind: 'prompt', text: '[Image: only.png]' },
    ]
    expect(promptHistoryFromTranscript(entries)).toEqual([
      'inspect this',
      'first prompt',
    ])
  })

  test('walks newest-first, then forward, and restores the unfinished draft', () => {
    const first = navigatePromptHistoryUp(null, 'unfinished draft', [
      'newest',
      'older',
    ])
    expect(first).toMatchObject({ value: 'newest', cursorOffset: 0 })

    const second = navigatePromptHistoryUp(
      first?.navigation ?? null,
      first?.value ?? '',
      [],
    )
    expect(second).toMatchObject({ value: 'older', cursorOffset: 0 })
    expect(
      navigatePromptHistoryUp(
        second?.navigation ?? null,
        second?.value ?? '',
        [],
      ),
    ).toBeNull()

    const newer = navigatePromptHistoryDown(second?.navigation ?? null)
    expect(newer).toMatchObject({
      value: 'newest',
      cursorOffset: 'newest'.length,
    })
    expect(navigatePromptHistoryDown(newer?.navigation ?? null)).toEqual({
      navigation: null,
      value: 'unfinished draft',
      cursorOffset: 'unfinished draft'.length,
    })
  })

  test('leaves Arrow keys to multiline cursor movement when another line exists', () => {
    expect(canNavigatePromptHistoryUp('first\nsecond', 7)).toBe(false)
    expect(canNavigatePromptHistoryUp('first\nsecond', 3)).toBe(true)
    expect(canNavigatePromptHistoryDown('first\nsecond', 3)).toBe(false)
    expect(canNavigatePromptHistoryDown('first\nsecond', 8)).toBe(true)
  })
})
