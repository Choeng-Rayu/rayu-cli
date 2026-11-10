import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { APIError } from '@anthropic-ai/sdk/index.js'
import { getAssistantMessageFromError } from '../src/services/api/errors.ts'
import {
  estimateMediaBytes,
  getMediaCompactBudgetBytes,
  getRequestMessagesBudgetBytes,
  SHED_IMAGE_PLACEHOLDER,
  shedMediaToFitRequestBudget,
} from '../src/utils/mediaBytes.ts'
import {
  MEDIA_COMPACT_BUDGET_BYTES,
  MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY,
  REQUEST_MESSAGES_BUDGET_BYTES,
  REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
} from '../src/constants/apiLimits.ts'
import { createAttachmentMessage } from '../src/utils/attachments.ts'
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

describe('estimateMediaBytes · attachment messages', () => {
  test('counts an @-mentioned image attachment (was invisible: 0 bytes)', () => {
    const att = createAttachmentMessage({
      type: 'file',
      filename: '/tmp/shot.png',
      displayPath: 'shot.png',
      content: {
        type: 'image',
        file: { base64: 'C'.repeat(3000), type: 'image/png', originalSize: 1 },
      },
    } as never) as Message
    expect(estimateMediaBytes([att])).toBe(3000)
  })
})

describe('shedMediaToFitRequestBudget', () => {
  const api = (ms: Message[]) => ms as (UserMessage | AssistantMessage)[]

  test('leaves a request under budget untouched (same array)', () => {
    const input = api([imageMessage(1000), textMessage('hi')])
    const out = shedMediaToFitRequestBudget(input, 1_000_000)
    expect(out.shedCount).toBe(0)
    expect(out.messages).toBe(input)
  })

  test('resumed session: old images are shed oldest-first until "hi" fits', () => {
    const input = api([
      imageMessage(3_000_000),
      imageMessage(3_000_000),
      imageMessage(3_000_000),
      textMessage('hi'),
    ])
    const out = shedMediaToFitRequestBudget(input, 4_000_000)
    // 9MB → must drop two images; the newest old image survives.
    expect(out.shedCount).toBe(2)
    expect(estimateMediaBytes(out.messages)).toBe(3_000_000)
    expect(estimateMediaBytes([out.messages[2]!])).toBe(3_000_000)
    expect(out.totalBytes).toBeLessThanOrEqual(4_000_000)
    const first = out.messages[0]!.message.content as { type: string; text?: string }[]
    expect(first[0]).toEqual({ type: 'text', text: SHED_IMAGE_PLACEHOLDER })
    // Input not mutated.
    expect(estimateMediaBytes(input)).toBe(9_000_000)
  })

  test('sheds images nested in tool_result (screenshots from Read/MCP tools)', () => {
    const toolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'mcp-1',
          content: [
            { type: 'text', text: 'screenshot' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'D'.repeat(5_000_000) },
            },
          ],
        },
      ],
    }) as Message
    const out = shedMediaToFitRequestBudget(api([toolResult, textMessage('hi')]), 1_000_000)
    expect(out.shedCount).toBe(1)
    const block = (out.messages[0]!.message.content as { type: string; content: unknown[] }[])[0]!
    expect(block.type).toBe('tool_result')
    expect(block.content).toEqual([
      { type: 'text', text: 'screenshot' },
      { type: 'text', text: SHED_IMAGE_PLACEHOLDER },
    ])
  })

  test('sheds a huge image in the LATEST tool result (tool results are type "user")', () => {
    // Reviewer repro: agent reads a big screenshot; the tool result is the last
    // user message, so "protect the last user message" left 9MB unshed → 413.
    const bigToolResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'E'.repeat(9_000_000) } }],
        },
      ],
    }) as Message
    // History: an older turn's image, the human's current text turn, then the
    // agent's big tool result. The tool result is last and is NOT the human turn.
    const input = api([
      imageMessage(2_000_000),
      textMessage('find the bug'),
      bigToolResult,
    ])
    const out = shedMediaToFitRequestBudget(input, 7_000_000)
    expect(out.shedCount).toBe(2)
    expect(out.totalBytes).toBeLessThanOrEqual(7_000_000)
    const nested = (out.messages[2]!.message.content as { content: unknown[] }[])[0]!.content
    expect(nested).toEqual([{ type: 'text', text: SHED_IMAGE_PLACEHOLDER }])
    // The human's own text turn is untouched (same object).
    expect(out.messages[1]).toBe(input[1]!)
  })

  test('a mid-turn paste is still protected once a tool result lands after it', () => {
    // Reviewer repro: user pastes an image, then a tool result becomes the last
    // user message; the old code then shed the USER's own image.
    const humanTurn = createUserMessage({
      content: [
        { type: 'text', text: 'what is wrong in this screenshot?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'F'.repeat(5_000_000) } },
      ],
    }) as Message
    const toolResultText = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'grep-1', content: [{ type: 'text', text: 'no matches' }] },
      ],
    }) as Message
    const out = shedMediaToFitRequestBudget(api([humanTurn, toolResultText]), 4_000_000)
    expect(out.shedCount).toBe(0)
    expect(estimateMediaBytes(out.messages)).toBe(5_000_000)
  })

  test('a tool result carrying a text sibling is NOT mistaken for the human turn', () => {
    // normalizeMessagesForAPI injects `{type:'text',text:'Tool loaded.'}` as a
    // sibling inside a tool_result message. Treating "has a non-tool_result
    // block" as human classified that synthetic message as the user's turn and
    // shed the real image.
    const humanTurn = createUserMessage({
      content: [
        { type: 'text', text: 'check this screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'G'.repeat(5_000_000) } },
      ],
    }) as Message
    const toolResultWithSibling = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'search-1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'text', text: 'Tool loaded.' },
      ],
    }) as Message
    const input = api([humanTurn, toolResultWithSibling])
    const out = shedMediaToFitRequestBudget(input, 4_000_000)
    // Nothing is sheddable except the user's own image, which must survive.
    expect(out.shedCount).toBe(0)
    expect(estimateMediaBytes(out.messages)).toBe(5_000_000)
    expect(out.messages[0]).toBe(input[0]!)
  })

  test('a merged caveat+prompt message (isMeta) still protects the pasted image', () => {
    // mergeUserMessages preserves isMeta, so a prompt submitted with a synthetic
    // caveat prefix becomes ONE isMeta message that holds the user's image.
    const mergedTurn = createUserMessage({
      content: [
        { type: 'text', text: 'Caveat: the messages below were generated by the user.' },
        { type: 'text', text: 'what is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'H'.repeat(5_000_000) } },
      ],
      isMeta: true,
    }) as Message
    const out = shedMediaToFitRequestBudget(api([mergedTurn]), 4_000_000)
    expect(out.shedCount).toBe(0)
    expect(estimateMediaBytes(out.messages)).toBe(5_000_000)
  })

  test('a mid-turn paste merged into a tool-result message keeps its image', () => {
    // A prompt queued while a tool runs is normalized into ONE message:
    // [tool_result, text, image]. Rejecting "any message with a tool_result"
    // dropped that fresh paste.
    const mergedPaste = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'read-1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'text', text: 'and what about this one?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'I'.repeat(3_000_000) } },
      ],
    }) as Message
    const input = api([imageMessage(5_000_000), textMessage('hi'), mergedPaste])
    const out = shedMediaToFitRequestBudget(input, 4_000_000)
    // The older turn's image is shed; the mid-turn paste is kept.
    expect(out.shedCount).toBe(1)
    expect(out.totalBytes).toBeLessThanOrEqual(4_000_000)
    expect(estimateMediaBytes([out.messages[2]!])).toBe(3_000_000)
    expect(out.messages[2]).toBe(input[2]!)
  })

  test('never sheds the current (last user) turn', () => {
    const input = api([textMessage('look'), imageMessage(5_000_000)])
    const out = shedMediaToFitRequestBudget(input, 1_000_000)
    expect(out.shedCount).toBe(0)
    expect(estimateMediaBytes(out.messages)).toBe(5_000_000)
  })
})

describe('getRequestMessagesBudgetBytes', () => {
  afterEach(() => {
    delete process.env.RAYU_REQUEST_BODY_BUDGET_BYTES
  })
  test('the send budget fits under the 8 MiB gateway cap', () => {
    expect(getRequestMessagesBudgetBytes()).toBe(REQUEST_MESSAGES_BUDGET_BYTES)
    expect(REQUEST_MESSAGES_BUDGET_BYTES).toBeLessThan(8 * 1024 * 1024)
  })

  test('media auto-compact never fires on a request the shedder can still send', () => {
    // Full compaction keeps no messagesToKeep, so its trigger being BELOW the
    // shedder budget would summarize a pending paste the shedder would have sent.
    expect(MEDIA_COMPACT_BUDGET_BYTES).toBeGreaterThanOrEqual(
      REQUEST_MESSAGES_BUDGET_BYTES,
    )
    expect(MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY).toBeGreaterThanOrEqual(
      REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
    )
  })
  test('honors a positive override', () => {
    process.env.RAYU_REQUEST_BODY_BUDGET_BYTES = '30000000'
    expect(getRequestMessagesBudgetBytes()).toBe(30_000_000)
    expect(getRequestMessagesBudgetBytes(true)).toBe(30_000_000)
  })
  test('a direct first-party key gets the larger cap, not the gateway one', () => {
    expect(getRequestMessagesBudgetBytes(false)).toBe(REQUEST_MESSAGES_BUDGET_BYTES)
    expect(getRequestMessagesBudgetBytes(true)).toBe(
      REQUEST_MESSAGES_BUDGET_BYTES_FIRST_PARTY,
    )
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

  test('a direct first-party key keeps the larger media budget', () => {
    expect(getMediaCompactBudgetBytes(false)).toBe(MEDIA_COMPACT_BUDGET_BYTES)
    expect(getMediaCompactBudgetBytes(true)).toBe(
      MEDIA_COMPACT_BUDGET_BYTES_FIRST_PARTY,
    )
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

  test('text-heavy history with one small old image does NOT blame images', () => {
    // The reported case: the user never pasted an image, one small screenshot
    // sits in history, and text is what crosses the cap.
    const messagesForAPI: (UserMessage | AssistantMessage)[] = [
      imageMessage(50_000),
      textMessage('x'.repeat(3_000_000)),
      textMessage('hi'),
    ]
    const text = textOf(
      getAssistantMessageFromError(requestTooLargeError(), 'deepseek-v4-pro', {
        messagesForAPI,
      }),
    )
    expect(text).not.toContain('images')
    expect(text).toContain('history exceeds the request size limit')
  })

  test('falls back to the generic message when no request messages are available', () => {
    const text = textOf(
      getAssistantMessageFromError(requestTooLargeError(), 'deepseek-v4-pro'),
    )
    expect(text).toContain('Request too large')
  })
})
