/**
 * Tail-reading resume path (`readTranscriptTailBlocks`).
 *
 * ── WHAT THIS PROTECTS ──────────────────────────────────────────────────────────
 *
 * Resuming a large session used to read the WHOLE transcript, JSON.parse every
 * record, run the formatter on all of them, and then keep only the last 400
 * blocks. On a real 25.6 MB session that is 2794 records parsed and 2797 blocks
 * built to keep 400 — ~10x wasted work, with the entire file resident in the
 * extension host. Resuming is exactly when the editor is already under memory
 * pressure, so the spike is the thing being removed.
 *
 * The replacement reads growing windows from the END of the file. These tests pin
 * the two properties that make it a safe replacement:
 *
 *   1. EQUIVALENCE — for any file, the tail path returns exactly what a
 *      full-file parse would have returned. This is the whole contract; the
 *      windowing is an implementation detail behind it.
 *   2. LINE SAFETY — a window that starts mid-line must not emit a block for the
 *      fragment, and a window smaller than one line must not lose that line.
 *
 * Equivalence is asserted against a locally-written full-file parser rather than
 * against hand-picked expected blocks, so a formatter change cannot make the test
 * pass while the resume path diverges.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_RESTORED_BLOCKS,
  readTranscriptTailBlocks,
} from '../src/vscode/host/sessionHistory.js'
import { formatMessageForVSCode } from '../src/vscode/host/panel/formatActivityForVSCode.js'

let dir: string | undefined

async function tempFile(name: string, contents: string): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), 'rayu-tail-read-'))
  const path = join(dir, name)
  await writeFile(path, contents, 'utf8')
  return path
}

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = undefined
  }
})

/** One user prompt record. */
function userRecord(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  })
}

/** One assistant text record. */
function assistantRecord(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  })
}

function jsonl(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

/**
 * The pre-fix behaviour, kept as the oracle: read everything, parse everything,
 * format everything, then keep the tail. Written against the same formatter, so
 * the comparison isolates the WINDOWING rather than the formatting.
 */
function fullFileBlocks(contents: string): ReturnType<typeof formatMessageForVSCode> {
  const blocks: ReturnType<typeof formatMessageForVSCode> = []
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    if (record.type !== 'user' && record.type !== 'assistant') continue
    const message = record.message as Record<string, unknown> | undefined
    const content = message?.content
    if (typeof content === 'string' && content.includes('<command-name>')) continue
    blocks.push(...formatMessageForVSCode(record as never))
  }
  return blocks
}

/** The text of every block, for order-sensitive comparison. */
function texts(blocks: readonly unknown[]): string[] {
  return blocks.map(block => {
    const b = block as Record<string, unknown>
    return typeof b.text === 'string' ? b.text : JSON.stringify(b)
  })
}

describe('readTranscriptTailBlocks — equivalence with a full-file parse', () => {
  test('small file (window covers the whole file) returns everything', async () => {
    const contents = jsonl(
      userRecord('prompt one'),
      assistantRecord('reply one'),
      userRecord('prompt two'),
      assistantRecord('reply two'),
    )
    const path = await tempFile('small.jsonl', contents)

    const got = await readTranscriptTailBlocks(path)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)))
  })

  test('multi-window growth still matches the full-file result', async () => {
    // 300 records, forced through many small windows (64 bytes), so the growth
    // loop runs repeatedly rather than being exercised only once.
    const lines: string[] = []
    for (let i = 0; i < 300; i++) {
      lines.push(i % 2 === 0 ? userRecord(`prompt-${i}`) : assistantRecord(`reply-${i}`))
    }
    const contents = jsonl(...lines)
    const path = await tempFile('multi.jsonl', contents)

    const got = await readTranscriptTailBlocks(path, 64)
    const want = fullFileBlocks(contents)
    expect(texts(got)).toEqual(texts(want).slice(-MAX_RESTORED_BLOCKS))
  })

  test('file with more blocks than the cap returns exactly the last cap', async () => {
    const total = MAX_RESTORED_BLOCKS + 250
    const lines: string[] = []
    for (let i = 0; i < total; i++) {
      lines.push(assistantRecord(`reply-${i}`))
    }
    const contents = jsonl(...lines)
    const path = await tempFile('capped.jsonl', contents)

    const got = await readTranscriptTailBlocks(path)
    const want = fullFileBlocks(contents)

    expect(got.length).toBe(MAX_RESTORED_BLOCKS)
    expect(texts(got)).toEqual(texts(want).slice(-MAX_RESTORED_BLOCKS))
  })

  test('a single line larger than the window is still parsed', async () => {
    // The oversized line is the FIRST record, so a window that fits only the
    // tail would drop it — proving the growth loop recovers it rather than
    // silently truncating the transcript.
    const huge = 'x'.repeat(20_000)
    const contents = jsonl(assistantRecord(huge), userRecord('after huge'))
    const path = await tempFile('huge-line.jsonl', contents)

    const got = await readTranscriptTailBlocks(path, 128)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)))
  })

  test('non-conversation records and command breadcrumbs are excluded', async () => {
    const contents = jsonl(
      JSON.stringify({ type: 'summary', summary: 'not a turn' }),
      userRecord('<command-name>/model</command-name>'),
      userRecord('a real prompt'),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      assistantRecord('a real reply'),
    )
    const path = await tempFile('filtered.jsonl', contents)

    const got = await readTranscriptTailBlocks(path)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)))
  })
})

describe('readTranscriptTailBlocks — edge cases', () => {
  test('empty file yields no blocks', async () => {
    const path = await tempFile('empty.jsonl', '')
    expect(await readTranscriptTailBlocks(path)).toEqual([])
  })

  test('file containing only a newline yields no blocks', async () => {
    const path = await tempFile('newline.jsonl', '\n')
    expect(await readTranscriptTailBlocks(path)).toEqual([])
  })

  test('trailing blank lines do not become blocks', async () => {
    const contents = `${jsonl(userRecord('only'), assistantRecord('reply'))}\n\n\n`
    const path = await tempFile('trailing.jsonl', contents)

    const got = await readTranscriptTailBlocks(path)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)))
  })

  test('a crash-truncated final line is skipped, not fatal', async () => {
    // The engine appends line-by-line; a hard kill mid-write leaves a partial
    // JSON object. It must not discard the intact records before it.
    const contents = `${jsonl(userRecord('intact'), assistantRecord('also intact'))}{"type":"assist`
    const path = await tempFile('truncated.jsonl', contents)

    const got = await readTranscriptTailBlocks(path)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)))
    expect(got.length).toBeGreaterThan(0)
  })

  test('a window starting exactly on a record boundary keeps that record', async () => {
    // A window start can land mid-line or exactly on a newline. The leading element is
    // kept rather than dropped, because a fragment is rejected by JSON.parse anyway and
    // an exact-boundary start holds a COMPLETE record. This pins the exact-boundary half
    // of that reasoning, which only becomes observable once the window is big enough to
    // satisfy the cap on its own — the earlier reads would otherwise grow and hide it.
    const total = MAX_RESTORED_BLOCKS + 100
    const records: string[] = []
    for (let i = 0; i < total; i++) records.push(assistantRecord(`reply-${i}`))
    const contents = `${records.join('\n')}\n`
    // Uniform record length, so any multiple of (record + newline) is a real boundary.
    const stride = Buffer.byteLength(`${records[0]}\n`, 'utf8')
    const window = stride * (MAX_RESTORED_BLOCKS + 50)
    const path = await tempFile('boundary.jsonl', contents)

    const got = await readTranscriptTailBlocks(path, window)
    expect(texts(got)).toEqual(
      texts(fullFileBlocks(contents)).slice(-MAX_RESTORED_BLOCKS),
    )
    expect(got.length).toBe(MAX_RESTORED_BLOCKS)
  })

  test('a multi-byte character split across a window boundary is not corrupted', async () => {
    // The reader holds the region as BYTES and decodes it once. Decoding each chunk
    // separately and concatenating the strings would turn a straddling multi-byte
    // character into U+FFFD on both sides of the seam — the record containing it stops
    // being valid JSON and is silently dropped. Content is deliberately multi-byte-heavy
    // and the window deliberately tiny, so growth crosses many character boundaries.
    //
    // 120 records is below the 400 cap on purpose: growth must run all the way to the
    // start of the file, and every record has to survive. A single dropped record makes
    // the length assertion fail, not just the content comparison.
    const lines: string[] = []
    for (let i = 0; i < 120; i++) {
      lines.push(assistantRecord(`héllo-日本語-😀-${i}-${'é'.repeat(40)}`))
    }
    const contents = jsonl(...lines)
    const path = await tempFile('multibyte.jsonl', contents)

    const got = await readTranscriptTailBlocks(path, 64)
    expect(texts(got)).toEqual(
      texts(fullFileBlocks(contents)).slice(-MAX_RESTORED_BLOCKS),
    )
    expect(got.length).toBe(120)
  })

  test('a mid-file window start never emits a block for the split fragment', async () => {
    // Force a window far smaller than the file so the first read lands inside a
    // line. If the leading fragment were parsed as a record it would add a
    // phantom block; the result must match the full-file parse exactly.
    const lines: string[] = []
    for (let i = 0; i < 60; i++) {
      lines.push(userRecord(`prompt-${i}`))
      lines.push(assistantRecord(`reply-${i}`))
    }
    const contents = jsonl(...lines)
    const path = await tempFile('midline.jsonl', contents)

    const got = await readTranscriptTailBlocks(path, 100)
    expect(texts(got)).toEqual(texts(fullFileBlocks(contents)).slice(-MAX_RESTORED_BLOCKS))
  })
})
