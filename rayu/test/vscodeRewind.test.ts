/**
 * Rewind / file-checkpoint wiring.
 *
 * The runtime path needs a live engine + control client, so this asserts the pieces that
 * matter and can be checked statically: checkpointing is enabled, prompts carry a uuid that
 * is stored on the entry AND sent on the stdin frame, and the host issues the exact
 * `rewind_files` payload the engine schema defines. Dispatch routing is covered separately
 * by `vscodeWebviewDispatch.test.ts` (its exhaustiveness check now includes `rewindFiles`).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const sessionHandle = read('src/vscode/host/panel/sessionHandle.ts')
const protocol = read('src/vscode/shared/webviewProtocol.ts')

describe('rewind — engine contract', () => {
  test('file checkpointing is enabled for the headless engine', () => {
    expect(sessionHandle).toContain("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1'")
  })

  test('a prompt generates a uuid, stores it on the entry, and sends it on the frame', () => {
    // Generated per prompt.
    expect(sessionHandle).toContain('randomUUID()')
    // Stored on the prompt entry so the Restore control can show.
    expect(sessionHandle).toMatch(/kind: 'prompt'[\s\S]{0,300}messageUuid/)
    // Sent on the stdin user frame so the engine snapshots under the same id.
    expect(sessionHandle).toMatch(/uuid: messageUuid/)
  })

  test('the rewind request matches the control schema exactly', () => {
    // { subtype:'rewind_files', user_message_id, dry_run? } — subtype is the request() key,
    // the payload carries user_message_id + dry_run.
    expect(sessionHandle).toContain("'rewind_files'")
    expect(sessionHandle).toContain('user_message_id: messageUuid')
    expect(sessionHandle).toContain('dry_run: dryRun')
  })
})

describe('rewind — protocol', () => {
  test('the prompt entry carries an optional messageUuid', () => {
    expect(protocol).toMatch(/kind: 'prompt'[\s\S]{0,900}messageUuid\?: string/)
  })

  test('the webview can send a rewindFiles message', () => {
    expect(protocol).toMatch(/\{ type: 'rewindFiles'; messageUuid: string \}/)
  })
})
