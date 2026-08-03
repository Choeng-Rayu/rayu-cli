import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLinkedTransportPair } from '../src/services/mcp/InProcessTransport.ts'

/**
 * End-to-end test of the RAYU MCP server over the in-process transport pair.
 *
 * This drives the real request handlers against the real tool registry
 * (initialize → tools/list → tools/call → prompts/*), which is what a host
 * agent does. It is the test that actually proves RAYU is usable from inside
 * Claude Code / Codex: an adapter unit test cannot catch protocol-level
 * mistakes like a missing `structuredContent`.
 */

let workDir: string
let client: Client
let close: (() => Promise<void>) | undefined

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'rayu-mcp-e2e-'))
  await writeFile(join(workDir, 'hello.txt'), 'hello from rayu\n')

  const { createRayuMcpServer } = await import(
    '../src/plugins/mcpServer/index.ts'
  )
  const server = createRayuMcpServer({
    cwd: workDir,
    debug: false,
    verbose: false,
  })
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)

  client = new Client({ name: 'rayu-mcp-e2e', version: '0.0.0' })
  await client.connect(clientTransport)

  close = async () => {
    await client.close().catch(() => {})
    await server.close().catch(() => {})
  }
})

afterAll(async () => {
  await close?.()
  await rm(workDir, { recursive: true, force: true })
})

/** Exactly what `client.callTool()` resolves to, per the installed SDK. */
type CallToolOutcome = Awaited<ReturnType<Client['callTool']>>

/**
 * Concatenates the text blocks of a tools/call result.
 *
 * The SDK's result type is a union that still includes the legacy `toolResult`
 * shape, so `content` is read defensively; RAYU always returns the `content`
 * form.
 */
function resultText(result: CallToolOutcome): string {
  const content = (result as { content?: unknown }).content
  return ((content ?? []) as { type: string; text?: string }[])
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n')
}

describe('RAYU MCP server handshake', () => {
  test('advertises tool and prompt capabilities', () => {
    const capabilities = client.getServerCapabilities()
    expect(capabilities?.tools).toBeDefined()
    expect(capabilities?.prompts).toBeDefined()
  })

  test('identifies itself as rayu, not as a Claude Code server', () => {
    const info = client.getServerVersion()
    expect(info?.name).toBe('rayu')
    expect(info?.name).not.toContain('claude')
  })
})

describe('tools/list', () => {
  test('contains every tool the acceptance criteria require', async () => {
    const names = (await client.listTools()).tools.map(t => t.name)
    for (const required of [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'Skill',
      // billing-gated tool
      'GenerateImage',
    ]) {
      expect(names).toContain(required)
    }
  })

  test('excludes session-coupled and TUI-only tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name)
    for (const excluded of [
      'ExitPlanMode',
      'EnterPlanMode',
      'TodoWrite',
      'AskUserQuestion',
      'TaskCreate',
      'TaskOutput',
      'ToolSearch',
      'SendMessage',
    ]) {
      expect(names).not.toContain(excluded)
    }
  })

  test('every advertised tool has a description and object input schema', async () => {
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description!.length).toBeGreaterThan(0)
      expect(tool.inputSchema.type).toBe('object')
      // Non-object output schemas must be dropped, never sent as-is.
      if (tool.outputSchema) {
        expect(tool.outputSchema.type).toBe('object')
      }
    }
  })
})

describe('tools/call', () => {
  test('Read returns real file contents', async () => {
    const result = await client.callTool({
      name: 'Read',
      arguments: { file_path: join(workDir, 'hello.txt') },
    })
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toContain('hello from rayu')
  })

  test('Glob returns structuredContent matching its advertised schema', async () => {
    // Regression guard: the MCP SDK client rejects a result that omits
    // structuredContent when the server advertised an outputSchema. Without it,
    // every structured tool was unusable from a host.
    const result = await client.callTool({
      name: 'Glob',
      arguments: { pattern: '*.txt', path: workDir },
    })
    expect(result.isError).not.toBe(true)
    const structured = result.structuredContent as
      | { filenames?: string[]; numFiles?: number }
      | undefined
    expect(structured).toBeDefined()
    expect(structured?.numFiles).toBe(1)
    expect(structured?.filenames?.[0]).toBe(join(workDir, 'hello.txt'))
  })

  test('Grep finds content in the workspace', async () => {
    const result = await client.callTool({
      name: 'Grep',
      arguments: { pattern: 'hello from rayu', path: workDir },
    })
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toContain('hello.txt')
  })

  test('Bash executes and returns stdout', async () => {
    const result = await client.callTool({
      name: 'Bash',
      arguments: { command: 'echo mcp-bash-ok' },
    })
    expect(result.isError).not.toBe(true)
    expect(resultText(result)).toContain('mcp-bash-ok')
  })

  test('Write then Read round trips through the server', async () => {
    const target = join(workDir, 'written.txt')
    const write = await client.callTool({
      name: 'Write',
      arguments: { file_path: target, content: 'written by mcp\n' },
    })
    expect(write.isError).not.toBe(true)
    expect(await readFile(target, 'utf8')).toBe('written by mcp\n')

    const read = await client.callTool({
      name: 'Read',
      arguments: { file_path: target },
    })
    expect(resultText(read)).toContain('written by mcp')
  })

  test('Edit replaces content in a file the server has read', async () => {
    const target = join(workDir, 'editable.txt')
    await writeFile(target, 'before\n')
    // Edit enforces read-before-write; readFileState is shared across calls in
    // one server process, so the preceding Read satisfies it.
    await client.callTool({ name: 'Read', arguments: { file_path: target } })

    const edit = await client.callTool({
      name: 'Edit',
      arguments: {
        file_path: target,
        old_string: 'before',
        new_string: 'after',
      },
    })
    expect(edit.isError).not.toBe(true)
    expect(await readFile(target, 'utf8')).toBe('after\n')
  })

  test('the billing-gated tool is exposed and its gate is inherited, not re-implemented', async () => {
    // Deliberately does NOT invoke GenerateImage: a real call reaches a
    // provider and consumes credits, so it belongs in manual verification.
    // What is asserted here is the contract that makes the MCP path correct:
    //   1. the tool is advertised to the host, and
    //   2. its entitlement state is reported from the same gate the tool's own
    //      call() consults — so MCP cannot diverge from the TUI.
    const names = (await client.listTools()).tools.map(t => t.name)
    expect(names).toContain('GenerateImage')

    const { describeToolAuthRequirements } = await import(
      '../src/plugins/mcpServer/authGate.ts'
    )
    const gated = describeToolAuthRequirements()
    expect(gated.map(g => g.toolName).sort()).toEqual([
      'GenerateImage',
      'GenerateVideo',
    ])
    for (const entry of gated) {
      expect(typeof entry.planLocked).toBe('boolean')
      expect(typeof entry.limitReached).toBe('boolean')
    }
  })

  test('tool failures come back as isError, not a transport error', async () => {
    const result = await client.callTool({
      name: 'Read',
      arguments: { file_path: join(workDir, 'does-not-exist.txt') },
    })
    expect(result.isError).toBe(true)
  })

  test('refuses a tool outside the capability boundary', async () => {
    await expect(
      client.callTool({ name: 'TodoWrite', arguments: { todos: [] } }),
    ).rejects.toThrow(/not available over RAYU/)
  })

  test('refuses an unknown tool', async () => {
    await expect(
      client.callTool({ name: 'NoSuchTool', arguments: {} }),
    ).rejects.toThrow(/not available over RAYU/)
  })
})

describe('prompts', () => {
  test('prompts/list exposes RAYU skills with host-safe names', async () => {
    const { prompts } = await client.listPrompts()
    expect(Array.isArray(prompts)).toBe(true)
    for (const prompt of prompts) {
      expect(prompt.name).toMatch(/^[a-zA-Z0-9_.-]+$/)
      expect(typeof prompt.description).toBe('string')
    }
    // Unique names, so prompts/get is deterministic.
    expect(new Set(prompts.map(p => p.name)).size).toBe(prompts.length)
  })

  test('prompts/get expands a skill into user messages', async () => {
    const { prompts } = await client.listPrompts()
    expect(prompts.length).toBeGreaterThan(0)
    const result = await client.getPrompt({
      name: prompts[0]!.name,
      arguments: { args: '' },
    })
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages[0]!.role).toBe('user')
    expect(result.messages[0]!.content.type).toBe('text')
  })

  test('prompts/get rejects an unknown skill', async () => {
    await expect(
      client.getPrompt({ name: 'definitely-not-a-skill' }),
    ).rejects.toThrow(/not found/)
  })
})
