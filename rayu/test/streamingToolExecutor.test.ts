import { describe, expect, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'
import { StreamingToolExecutor } from '../src/services/tools/StreamingToolExecutor.ts'
import type { ToolUseContext, Tools } from '../src/Tool.ts'
import { createAssistantMessage } from '../src/utils/messages.ts'

function makeContext(): ToolUseContext {
  const inProgress = new Set<string>()
  return {
    abortController: new AbortController(),
    setInProgressToolUseIDs(update: (prev: Set<string>) => Set<string>) {
      inProgress.clear()
      for (const id of update(new Set(inProgress))) {
        inProgress.add(id)
      }
    },
  } as unknown as ToolUseContext
}

function makeToolUse(): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'MissingTool',
    input: {},
  } as ToolUseBlock
}

function makeExecutor(): StreamingToolExecutor {
  const canUseTool = (async () => ({ behavior: 'allow' })) as CanUseToolFn
  return new StreamingToolExecutor([] as unknown as Tools, canUseTool, makeContext())
}

describe('StreamingToolExecutor fallback discard', () => {
  test('suppresses pending tool results after streaming fallback discard', async () => {
    const assistantMessage = createAssistantMessage({
      content: [makeToolUse()],
    })

    const baseline = makeExecutor()
    baseline.addTool(makeToolUse(), assistantMessage)
    expect([...baseline.getCompletedResults()]).toHaveLength(1)

    const discarded = makeExecutor()
    discarded.addTool(makeToolUse(), assistantMessage)
    discarded.discard()

    expect([...discarded.getCompletedResults()]).toEqual([])

    const remaining = []
    for await (const update of discarded.getRemainingResults()) {
      remaining.push(update)
    }
    expect(remaining).toEqual([])
  })
})
