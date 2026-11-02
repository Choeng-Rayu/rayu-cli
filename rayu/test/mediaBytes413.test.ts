import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIError } from '@anthropic-ai/sdk/index.js'
import { getAssistantMessageFromError } from '../src/services/api/errors.ts'
import {
  estimateMediaBytes,
  getMediaCompactBudgetBytes,
} from '../src/utils/mediaBytes.ts'
import { MEDIA_COMPACT_BUDGET_BYTES } from '../src/constants/apiLimits.ts'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../src/types/message.ts'
import { createUserMessage } from '../src/utils/messages.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-media-413-'))
  process.env.RAYU_CONFIG_DIR = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.RAYU_CONFIG_DIR
  delete process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES
})

function imageMessage(base64Bytes: number): UserMessage {
  return createUserMessage({
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'A'.repeat(base64Bytes),
        },
      },
    ],
  }) as UserMessage
}

function textMessage(text: string): UserMessage {
  return createUserMessage({ content: text }) as UserMessage
}

// A 413 the way the API/SDK surfaces it: status 413, no PDF/image wording.
function requestTooLargeError(): APIError {
  return APIError.generate(
    413,
    { error: { message: 'request too large', type: 'invalid_request_error' } },
    'request too large',
    new Headers(),
  ) as APIError
}

function textOf(msg: AssistantMessage): string {
  const block = msg.message.content[0]
  return block && block.type === 'text' ? block.text : ''
}

describe('estimateMediaBytes', () => {
  test('counts base64 bytes of top-level image blocks', () => {
    expect(estimateMediaBytes([imageMessage(1000)])).toBe(1000)
  })

  test('counts images nested inside tool_result content', () => {
    const toolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [
            { type: 'text', text: 'here is the screenshot' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(2048) },
            },
          ],
        },
      ],
    }) as Message
    expect(estimateMediaBytes([toolResult])).toBe(2048)
  })

  test('ignores text and URL sources (no inline wire bytes)', () => {
    const urlImage = createUserMessage({
      content: [
        { type: 'text', text: 'plain text carries no media bytes' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
      ],
    }) as Message
    expect(estimateMediaBytes([urlImage, textMessage('more text')])).toBe(0)
  })

  test('sums bytes across a multi-message history', () => {
    expect(
      estimateMediaBytes([imageMessage(500), textMessage('ok'), imageMessage(1500)]),
    ).toBe(2000)
  })
})

describe('getMediaCompactBudgetBytes', () => {
  test('defaults to MEDIA_COMPACT_BUDGET_BYTES', () => {
    expect(getMediaCompactBudgetBytes()).toBe(MEDIA_COMPACT_BUDGET_BYTES)
  })

  test('honors a positive RAYU_MEDIA_COMPACT_BUDGET_BYTES override', () => {
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = '1234567'
    expect(getMediaCompactBudgetBytes()).toBe(1234567)
  })

  test('ignores a non-numeric or non-positive override', () => {
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = 'nonsense'
    expect(getMediaCompactBudgetBytes()).toBe(MEDIA_COMPACT_BUDGET_BYTES)
    process.env.RAYU_MEDIA_COMPACT_BUDGET_BYTES = '0'
    expect(getMediaCompactBudgetBytes()).toBe(MEDIA_COMPACT_BUDGET_BYTES)
  })
})

describe('getAssistantMessageFromError · 413 request too large', () => {
  test('accumulated media in prior history gets the /compact message, not "smaller file"', () => {
    // Images live in an EARLIER turn; the current (last) user turn is text only.
    // Removing the current turn's content cannot fix it, so the advice must be
    // about compacting the conversation, not sending a smaller file.
    const messagesForAPI: (UserMessage | AssistantMessage)[] = [
      imageMessage(2_000_000),
      imageMessage(2_000_000),
      textMessage('please continue'),
    ]
    const text = textOf(
      getAssistantMessageFromError(requestTooLargeError(), 'deepseek-v4-pro', {
        messagesForAPI,
      }),
    )
    // Assert the stable wording shared by both the interactive (/compact) and
    // non-interactive (start a new session) variants — getIsNonInteractiveSession
    // decides which, and tests run non-interactive.
    expect(text).toContain('accumulated images and attachments')
    expect(text).not.toContain('smaller file')
  })

  test('a single oversized upload in the current turn keeps the "smaller file" message', () => {
    // The only media is in the LAST user turn — a fresh oversized upload the
    // user can shrink or remove. No accumulated prior-history media.
    const messagesForAPI: (UserMessage | AssistantMessage)[] = [
      textMessage('here is a file'),
      imageMessage(6_000_000),
    ]
    const text = textOf(
      getAssistantMessageFromError(requestTooLargeError(), 'deepseek-v4-pro', {
        messagesForAPI,
      }),
    )
    expect(text).toContain('smaller file')
  })

  test('falls back to the generic message when no request messages are available', () => {
    const text = textOf(
      getAssistantMessageFromError(requestTooLargeError(), 'deepseek-v4-pro'),
    )
    expect(text).toContain('Request too large')
  })
})
