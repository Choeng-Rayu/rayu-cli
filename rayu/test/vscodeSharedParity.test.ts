import { describe, expect, test } from 'bun:test'
import * as channels from '../src/vscode/shared/attachChannels.js'
import * as telegram from '../src/telegram/telegramRemoteBridge.js'
import { IPC_PROMPT } from '../src/telegram/telegramRouter.js'
import { EFFORT_OPTIONS } from '../src/vscode/shared/inferenceSettings.js'
import { EFFORT_LEVELS } from '../src/utils/effort.js'
import { formatMessageForVSCode } from '../src/vscode/host/panel/formatActivityForVSCode.js'
import { formatMessageForWeb } from '../src/webBridge/formatActivityForWeb.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONNECT_FLAG } from '../src/vscode/shared/connectProtocol.js'
import { LOGIN_FLAG } from '../src/vscode/shared/loginProtocol.js'
import { PERMISSION_MODES as editorModes } from '../src/vscode/shared/permissionModes.js'
import { PERMISSION_MODES as cliModes, isExternalPermissionMode } from '../src/utils/permissions/PermissionMode.js'
import { summariseInput, resultText } from '../src/utils/activity/activityBlocks.js'

describe('shared CLI and editor contracts', () => {
  test('every attachment channel agrees with the publishing CLI', () => {
    const canonical = { ...telegram, IPC_PROMPT } as Record<string, unknown>
    for (const [name, value] of Object.entries(channels)) expect(value as any).toBe(canonical[name])
  })
  test('editor effort choices use the CLI scale; Auto is absent effort', () => {
    expect(EFFORT_OPTIONS.map(o => o.value)).toEqual([null, ...EFFORT_LEVELS])
  })
  test('formatters preserve shared input and result summaries', () => {
    const input = { file_path: 'src/a file.ts', ignored: 'not the label' }
    const tool: any = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input }] } }
    const editor = formatMessageForVSCode(tool)[0] as any
    expect(editor.label).toBe(summariseInput(input))
    expect(formatMessageForWeb(tool)[0]!.summary).toContain(editor.label)
    const content = [{ type: 'text', text: 'check passed' }]
    const result: any = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content }] } }
    expect((formatMessageForVSCode(result)[0] as any).text).toBe(resultText(content))
    expect(formatMessageForWeb(result)[0]!.summary).toContain(resultText(content))
  })
  test('CONNECT_FLAG and LOGIN_FLAG are recognized by vscodeHost entrypoint dispatch', () => {
    expect(CONNECT_FLAG).toBe('--rayucode-connect')
    expect(LOGIN_FLAG).toBe('--rayucode-login')
    const hostSource = readFileSync(resolve(import.meta.dir, '../src/entrypoints/vscodeHost.ts'), 'utf8')
    expect(hostSource).toContain('passthrough.includes(LOGIN_FLAG)')
    expect(hostSource).toContain('passthrough.indexOf(CONNECT_FLAG)')
  })
  test('editor permission modes are a subset of and recognized by the CLI permission modes', () => {
    for (const mode of editorModes) {
      expect((cliModes as readonly string[]).includes(mode.id)).toBe(true)
      expect(isExternalPermissionMode(mode.id as any)).toBe(true)
    }
  })
})
