import { describe, expect, test } from 'bun:test'
import {
  ConfigScopeSchema,
  McpJsonConfigSchema,
  McpServerConfigSchema,
} from '../src/services/mcp/types.ts'

describe('Rayu MCP config schema', () => {
  test('keeps generic MCP transports', () => {
    expect(
      McpServerConfigSchema().safeParse({
        type: 'http',
        url: 'https://mcp.example.com/mcp',
      }).success,
    ).toBe(true)

    expect(
      McpServerConfigSchema().safeParse({
        type: 'sse',
        url: 'https://mcp.example.com/sse',
      }).success,
    ).toBe(true)

    expect(
      McpServerConfigSchema().safeParse({
        command: 'node',
        args: ['server.js'],
      }).success,
    ).toBe(true)
  })

  test('rejects Claude.ai connector scope and proxy transport', () => {
    expect(ConfigScopeSchema().safeParse('claudeai').success).toBe(false)
    expect(
      McpServerConfigSchema().safeParse({
        type: 'claudeai-proxy',
        url: 'https://claude.ai/api/mcp',
      }).success,
    ).toBe(false)
  })

  test('loads standard .mcp.json shape', () => {
    const result = McpJsonConfigSchema().safeParse({
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/mcp',
        },
      },
    })

    expect(result.success).toBe(true)
  })
})
