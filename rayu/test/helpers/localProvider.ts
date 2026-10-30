import type { ServerResponse } from 'node:http'
import { startProviderServer } from './scriptedProvider.js'

/** A provider, not an engine: real routing, tools, permissions and streaming still run. */
export async function startLocalProvider() {
  return startProviderServer(replyToFixture)
}

/** The fixed fixture conversation: read, edit, run a check, then summarize. */
async function replyToFixture(body: Record<string, any>, res: ServerResponse): Promise<void> {
  const results = body.messages.filter((m: any) => m.role === 'tool')
  const latestUser = [...body.messages].reverse().find((m: any) => m.role === 'user')
  const questionTurn = JSON.stringify(latestUser?.content ?? '').includes('which file format')
  const questionResult = results.find((m: any) => m.tool_call_id === 'ask-file-format')
  const step = results.length
  const calls = [
    { id: 'read-fixture', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'fixture.txt' }) } },
    { id: 'edit-fixture', function: { name: 'Edit', arguments: JSON.stringify({ file_path: 'fixture.txt', old_string: 'before', new_string: 'after' }) } },
    { id: 'empty-check', function: { name: 'Bash', arguments: JSON.stringify({ command: 'true', description: 'Successful check without output' }) } },
  ]
  if (!body.stream) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 'nonstream', choices: [{ message: { role: 'assistant', content: 'Fixture summary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (delta: unknown, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `reply-${step}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  send({ role: 'assistant', content: '' })
  if (questionTurn) {
    if (!questionResult) {
      send({ content: 'I need your preference. ' })
      send({ tool_calls: [{
        index: 0,
        id: 'ask-file-format',
        type: 'function',
        function: {
          name: 'AskUserQuestion',
          arguments: JSON.stringify({
            questions: [{
              question: 'Which file format should I use?',
              header: 'File format',
              options: [
                { label: 'Text files (.txt)', description: 'Create plain text files' },
                { label: 'Python files (.py)', description: 'Create Python source files' },
              ],
              multiSelect: false,
            }],
          }),
        },
      }] })
      send({}, 'tool_calls')
    } else {
      const receivedAnswer = JSON.stringify(questionResult.content).includes('Text files (.txt)')
      send({ content: receivedAnswer ? 'I received your file-format choice.' : 'The answer was missing.' })
      send({}, 'stop')
    }
    res.end('data: [DONE]\n\n')
    return
  }
  send({ content: step === 0 ? 'Inspecting the fixture. ' : step === 3 ? 'Changed fixture.txt. ' : 'Continuing. ' })
  await new Promise(resolve => setTimeout(resolve, 40))
  if (step < calls.length) {
    send({ tool_calls: [{ index: 0, type: 'function', ...calls[step] }] })
    send({}, 'tool_calls')
  } else {
    send({ content: 'The check passed.' })
    send({}, 'stop')
  }
  res.end('data: [DONE]\n\n')
}
