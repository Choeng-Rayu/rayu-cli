/**
 * Test suite for End-to-End turn streaming via scripted engine and packaging invariants.
 *
 * Verifies:
 *  - Scripted fake engine drives a complete conversation turn with streaming deltas,
 *    protocol initialization, and turn completion through ChatSession.
 *  - VSIX package contents, lack of source maps, and version sync with package.json.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import pkg from '../package.json' with { type: 'json' }

mock.module('vscode', () => ({
  window: {
    showQuickPick: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: [],
  },
}))

const { ChatSession } = await import('../src/vscode/host/panel/sessionHandle.js')

const ROOT = resolve(import.meta.dir, '..')
const VSIX_PATH = join(ROOT, `dist/rayucode-${pkg.version}.vsix`)
const STAGE_PKG_JSON = join(ROOT, 'dist/vscode-stage/package.json')

describe('End-to-End scripted engine streaming turn', () => {
  let tempDir: string
  let fakeEngineScript: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rayucode-e2e-'))
    fakeEngineScript = join(tempDir, 'fakeEngine.cjs')

    // Scripted fake engine implementing the control protocol and streaming turn
    const scriptContent = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// Initial announcement conforming to SDKSystemMessageSchema
const initSystem = {
  type: 'system',
  subtype: 'init',
  claude_code_version: '${pkg.version}',
  cwd: '/test',
  tools: ['Bash', 'Read'],
  mcp_servers: [],
  model: 'claude-3-7-sonnet',
  permissionMode: 'default',
  slash_commands: ['review', 'cost'],
  output_style: 'normal',
  skills: [],
  apiKeySource: 'none',
  protocolVersion: 1,
  plugins: [],
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'test-session-id'
};
process.stdout.write(JSON.stringify(initSystem) + '\\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === 'control_request' && msg.request) {
    if (msg.request.subtype === 'initialize') {
      const res = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            commands: [{ name: 'cost', description: 'Show cost', argumentHint: '' }],
            agents: [],
            output_style: 'normal',
            available_output_styles: ['normal'],
            models: [{ value: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', description: 'Sonnet' }],
            account: { email: 'dev@rayu.ai' },
          }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
      return;
    }

    if (msg.request.subtype === 'get_context_usage') {
      const res = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            categories: [],
            totalTokens: 1000,
            maxTokens: 200000,
            rawMaxTokens: 200000,
            percentage: 0.5,
            gridRows: [],
            model: 'claude-3-7-sonnet',
            memoryFiles: [],
            mcpTools: [],
            agents: [],
            isAutoCompactEnabled: false,
            apiUsage: null,
          }
        }
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
      return;
    }

    if (msg.request.subtype === 'get_settings') {
      const res = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            inference: {
              supportsEffort: false,
              supportedLevels: [],
              effort: null,
              effortEnvOverride: null,
              supportsThinking: false,
              thinkingEnabled: false,
            },
          },
        },
      };
      process.stdout.write(JSON.stringify(res) + '\\n');
      return;
    }

    const defaultRes = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {},
      },
    };
    process.stdout.write(JSON.stringify(defaultRes) + '\\n');
    return;
  }

  if (msg.type === 'user') {
    // Emit streaming tokens
    const delta1 = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' }
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000001',
      session_id: 'test-session-id'
    };
    const delta2 = {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world!' }
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000002',
      session_id: 'test-session-id'
    };
    const result = {
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      result: 'Hello world!',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      },
      modelUsage: {},
      permission_denials: [],
      uuid: '00000000-0000-0000-0000-000000000003',
      session_id: 'test-session-id'
    };

    process.stdout.write(JSON.stringify(delta1) + '\\n');
    process.stdout.write(JSON.stringify(delta2) + '\\n');
    process.stdout.write(JSON.stringify(result) + '\\n');
  }
});
`
    writeFileSync(fakeEngineScript, scriptContent, { mode: 0o755 })
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('drives a deterministic streaming turn end-to-end', async () => {
    const receivedPartials: string[] = []
    let turnRunningStates: boolean[] = []
    let completedMessageId: string | null = null

    const session = new (ChatSession as any)(
      { enginePath: fakeEngineScript, cwd: tempDir },
      {
        onEntry: () => {},
        onPartial: (_id, _kind, delta) => {
          receivedPartials.push(delta)
        },
        onComplete: id => {
          completedMessageId = id
        },
        onTurnState: running => {
          turnRunningStates.push(running)
        },
        onModelInfo: () => {},
        onError: err => {
          throw new Error(`Unexpected session error: ${err}`)
        },
        onPermissionRequest: () => {},
        onPermissionCancelled: () => {},
        onSessionEnded: () => {},
        onReviewCleared: () => {},
        onCommands: () => {},
        onContextUsage: () => {},
        onMcpServers: () => {},
        onInferenceSettings: () => {},
        onReviewFiles: () => {},
      },
    )

    try {
      await session.submitPrompt('Test turn')

      // Wait up to 2 seconds for stream to complete
      for (let i = 0; i < 40; i++) {
        if (completedMessageId !== null && !session.isTurnRunning) break
        await new Promise(r => setTimeout(r, 50))
      }

      expect(receivedPartials).toEqual(['Hello ', 'world!'])
      expect(completedMessageId).not.toBeNull()
      expect(session.isTurnRunning).toBe(false)
      expect(turnRunningStates).toContain(true)
      expect(turnRunningStates[turnRunningStates.length - 1]).toBe(false)

      // Transcript contains both the user prompt and completed assistant message
      expect(session.transcript.length).toBeGreaterThanOrEqual(2)
      const assistant = session.transcript.find(t => t.kind === 'assistant') as { text: string } | undefined
      expect(assistant?.text).toBe('Hello world!')
    } finally {
      session.dispose()
    }
  })
})

describe('VSIX packaging and version synchronization', () => {
  test.if(existsSync(STAGE_PKG_JSON))('staged package.json version matches rayu/package.json', () => {
    const stagePkg = JSON.parse(readFileSync(STAGE_PKG_JSON, 'utf8'))
    expect(stagePkg.version).toBe(pkg.version)
  })

  test.if(existsSync(VSIX_PATH))('VSIX package contains all required artifacts and no source maps', () => {
    const res = Bun.spawnSync(['unzip', '-l', VSIX_PATH], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(res.exitCode).toBe(0)
    const list = res.stdout.toString()

    expect(list).toContain('extension/package.json')
    expect(list).toContain('extension/extension.js')
    expect(list).toContain('extension/engine.mjs')
    expect(list).toContain('extension/media/webview.js')
    expect(list).toContain('extension/media/webview.css')
    expect(list).toContain('extension/media/icon.svg')
    expect(list).toContain('extension/media/icon.png')
    expect(list).toContain('extension/readme.md')
    expect(list).toContain('extension/changelog.md')

    // Invariant: zero source maps packaged into VSIX
    expect(list.includes('.map')).toBe(false)
  })
})
