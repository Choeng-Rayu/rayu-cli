/**
 * VERIFICATION (not assumption) for the Edit-result payload change.
 *
 * Every assertion below runs the PRODUCTION functions — not reimplementations.
 *
 *   H1  A real Edit's result carries no part of the file. The result is what the
 *       transcript persists as `tool_use_result`, so this is the invariant that
 *       keeps a session small. The field it replaced was `originalFile` — the
 *       entire pre-edit contents — measured at 16.62 MB of one real 28.16 MB
 *       session (59% of the file), and 27.53 MB of 68.52 MB across four real
 *       sessions. Markers sit at the START, MIDDLE and END of the fixture so a
 *       size-capped leak cannot slip past, and a size bound catches a leak whose
 *       bytes happen to avoid every marker.
 *   H2  The MODEL never receives the file, even when a result still carries it.
 *       The input here is deliberately hostile — it contains the whole file — so
 *       the assertion is about the projection, not about the input.
 *   H3  The UI could never consume the bytes: the only reader was the native color
 *       renderer, which is a stub in Rayu (`expectColorDiff()` is null). That is
 *       WHY the bytes were dead, asserted rather than assumed.
 *   H4  The diff still renders from `firstLine` alone.
 *   H5  OLD transcripts still work. This is the one that was missing: `firstLine`
 *       began life as a REQUIRED key, so a pre-change record (which has
 *       `originalFile` and no `firstLine`) failed schema validation in
 *       `UserToolSuccessMessage` and its whole Edit row silently disappeared from a
 *       resumed session. H5 pins both halves — the record parses, and it renders.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { Writable } from 'node:stream'
import stripAnsi from 'strip-ansi'

import { FileEditToolUpdatedMessage } from '../src/components/FileEditToolUpdatedMessage.tsx'
import {
  expectColorDiff,
  getColorModuleUnavailableReason,
} from '../src/components/StructuredDiff/colorDiff.ts'
import { render } from '../src/ink.ts'
import { FileEditTool } from '../src/tools/FileEditTool/FileEditTool.ts'
import {
  AppStateProvider,
  getDefaultAppState,
} from '../src/state/AppState.tsx'
import { processToolResultBlock } from '../src/utils/toolResultStorage.ts'

/**
 * Markers at three depths, so a leak that carries only a PREFIX or only a SUFFIX
 * of the file is still caught. A single end-anchored marker (the earlier version)
 * passed against an `originalFile: contents.slice(0, 1000)` regression.
 *
 * They are placed well clear of the edit site on purpose: the diff legitimately
 * carries 3 lines of context either side (`CONTEXT_LINES`, `src/utils/diff.ts:9`),
 * so a marker next to the changed line would appear in the patch and read as a
 * false leak — which is exactly what the first version of this fixture did.
 */
const MARKER_START = 'ZZ_MARKER_START_ZZ'
const MARKER_MID = 'ZZ_MARKER_MID_ZZ'
const MARKER_END = 'ZZ_MARKER_END_ZZ'
const ALL_MARKERS = [MARKER_START, MARKER_MID, MARKER_END]

/** Distance from the edit site (line 2) to stay outside the diff's context window. */
const MARKER_OFFSET = 30

/**
 * A file big enough that its inclusion is unmistakable, with markers near the
 * start, the middle and the very end — all far from line 2, where the test edits.
 * Line 1 is a shebang on purpose: it is what `firstLine` legitimately carries, so
 * no marker is placed there.
 */
function bigFile(lines: number): string {
  const mid = Math.floor(lines / 2)
  const body = Array.from({ length: lines }, (_, i) => `const v${i} = ${i}`)
  body[MARKER_OFFSET] = `const v${MARKER_OFFSET} = ${MARKER_OFFSET} // ${MARKER_START}`
  body[mid] = `const v${mid} = ${mid} // ${MARKER_MID}`
  body[lines - 1] = `// ${MARKER_END}`
  return `#!/usr/bin/env node\n${body.join('\n')}\n`
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayu-edit-payload-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Collect rendered output as text. */
class CaptureStream extends Writable {
  output = ''
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (e?: Error) => void,
  ): void {
    this.output += chunk.toString()
    cb()
  }
}

async function renderText(node: React.ReactNode): Promise<string> {
  const stdout = new CaptureStream()
  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState()}>
      {node}
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    } as never,
  )
  await new Promise(r => setTimeout(r, 30))
  instance.unmount()
  instance.cleanup()
  return stripAnsi(stdout.output)
}

const patch = [
  {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: ['-const a = 1', '+const a = 2'],
  },
]

/** Run a real Edit of a 400-line marker-bearing file and return its result payload. */
async function callEditOnBigFile(): Promise<{
  data: Record<string, unknown>
  original: string
}> {
  const filePath = join(dir, 'target.ts')
  const original = bigFile(400)
  writeFileSync(filePath, original)

  const state = getDefaultAppState()
  const readFileState = new Map<string, unknown>([
    [
      filePath,
      {
        content: original,
        timestamp: Number.MAX_SAFE_INTEGER, // never stale
        offset: undefined,
        limit: undefined,
        isFullRead: true,
      },
    ],
  ])

  const result = await FileEditTool.call(
    {
      file_path: filePath,
      old_string: 'const v0 = 0',
      new_string: 'const v0 = 999',
      replace_all: false,
    } as never,
    {
      readFileState,
      userModified: false,
      updateFileHistoryState: () => {},
      dynamicSkillDirTriggers: new Set(),
      getAppState: () => state,
      setAppState: () => {},
      toolUseId: 'toolu_verify_1',
    } as never,
    undefined as never,
    { uuid: 'parent-verify-1' } as never,
  )

  return {
    data: (result as { data: Record<string, unknown> }).data,
    original,
  }
}

/** Every marker occurrence in `text`, so a failure names WHICH region leaked. */
function leakedMarkers(text: string): string[] {
  return ALL_MARKERS.filter(marker => text.includes(marker))
}

describe('H1 — a real Edit result carries no part of the file', () => {
  test('the whole result object is free of the original contents', async () => {
    const { data, original } = await callEditOnBigFile()

    // Sanity: the fixture really is large and really does contain the markers, so
    // the assertions below cannot pass merely because there was nothing to leak.
    expect(original.length).toBeGreaterThan(5000)
    expect(leakedMarkers(original)).toHaveLength(ALL_MARKERS.length)

    const serialized = JSON.stringify(data)

    // Position-aware: names the region if anything leaks.
    expect(leakedMarkers(serialized)).toEqual([])
    expect(data).not.toHaveProperty('originalFile')

    // Size bound, independent of marker placement: the result is a 1-line diff plus
    // two short strings, so it must be far smaller than the file it describes. This
    // is what catches a leak whose bytes dodge every marker.
    expect(serialized.length).toBeLessThan(original.length / 4)

    // The diff must survive — losing the patch would be a silent regression the
    // other way.
    expect(Array.isArray(data.structuredPatch)).toBe(true)

    // `firstLine` is the replacement, and it is the shebang — exactly what language
    // detection reads. One line, not 400.
    expect(data.firstLine).toBe('#!/usr/bin/env node')
  })
})

describe('H2 — the model never receives the file contents', () => {
  /**
   * Deliberately hostile: this result DOES carry the entire file, as a pre-change
   * transcript record or a future regression would. Asserting on this input makes
   * the check about the projection rather than about the input — the earlier
   * version omitted the field from the fixture, which made the assertion trivially
   * true and proved nothing.
   */
  const dataCarryingFile = {
    filePath: 'src/app.ts',
    oldString: 'const a = 1',
    newString: 'const a = 2',
    originalFile: bigFile(400),
    structuredPatch: patch,
    userModified: false,
    replaceAll: false,
  }

  test('the fixture really does carry the file', () => {
    expect(leakedMarkers(JSON.stringify(dataCarryingFile))).toHaveLength(
      ALL_MARKERS.length,
    )
  })

  test('mapToolResultToToolResultBlockParam emits prose only', () => {
    const block = FileEditTool.mapToolResultToToolResultBlockParam(
      dataCarryingFile as never,
      'toolu_h2',
    )
    const serialized = JSON.stringify(block)
    expect(leakedMarkers(serialized)).toEqual([])
    // It is a short string mentioning the path — nothing else.
    expect(block.content).toContain('src/app.ts')
    expect(block.content).toContain('has been updated successfully')
    expect(typeof block.content).toBe('string')
  })

  test('the persistence path never sees the file contents either', async () => {
    // processToolResultBlock is what builds the wire/API block from the tool result.
    const block = await processToolResultBlock(
      {
        name: FileEditTool.name,
        maxResultSizeChars: FileEditTool.maxResultSizeChars,
        mapToolResultToToolResultBlockParam:
          FileEditTool.mapToolResultToToolResultBlockParam.bind(FileEditTool),
      } as never,
      dataCarryingFile as never,
      'toolu_h2b',
    )
    expect(leakedMarkers(JSON.stringify(block))).toEqual([])
  })
})

describe('H3 — the native renderer that would read the bytes cannot run', () => {
  test('expectColorDiff() is null, so the renderer is unreachable', () => {
    // This is the reason the full contents had no consumer: the only reader is the
    // native color renderer, and in Rayu the native module is a stub. If this ever
    // returns non-null, a consumer for file bytes exists again and H1 must be
    // re-examined before any further size reduction is claimed.
    expect(getColorModuleUnavailableReason()).toBe('unavailable')
    expect(expectColorDiff()).toBeNull()
  })
})

describe('H4 — the diff still renders from firstLine alone', () => {
  test('the updated-message draws the patch with a shebang firstLine', async () => {
    const rendered = await renderText(
      <FileEditToolUpdatedMessage
        filePath={join(dir, 'render.ts')}
        structuredPatch={patch}
        firstLine="#!/usr/bin/env node"
        verbose={true}
      />,
    )
    expect(rendered).toContain('const a = 1')
    expect(rendered).toContain('const a = 2')
  })

  test('a null firstLine still renders (no shebang to detect)', async () => {
    const rendered = await renderText(
      <FileEditToolUpdatedMessage
        filePath={join(dir, 'noext')}
        structuredPatch={patch}
        firstLine={null}
        verbose={true}
      />,
    )
    expect(rendered.length).toBeGreaterThan(0)
  })
})

describe('H5 — a PRE-CHANGE transcript record still parses and renders', () => {
  /**
   * The record shape written before this change: it has `originalFile` and no
   * `firstLine`. `UserToolSuccessMessage` validates a resumed record against
   * `outputSchema` and returns null when that fails, so requiring `firstLine`
   * made every old Edit row vanish from a resumed session. No test covered this,
   * which is why the regression shipped green.
   */
  const oldFormatRecord = {
    filePath: 'src/app.ts',
    oldString: 'const a = 1',
    newString: 'const a = 2',
    originalFile: 'const a = 1\nconst b = 2\n',
    structuredPatch: patch,
    userModified: false,
    replaceAll: false,
  }

  test('the real output schema accepts it (this is what un-hid the row)', () => {
    const parsed = FileEditTool.outputSchema.safeParse(oldFormatRecord)
    expect(parsed.success).toBe(true)
  })

  test('it renders rather than returning null', async () => {
    const parsed = FileEditTool.outputSchema.safeParse(oldFormatRecord)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    // `firstLine` is absent on an old record; the renderer must normalize that
    // rather than treat it as a failure.
    const rendered = (FileEditTool as never as {
      renderToolResultMessage: (
        data: unknown,
        progress: unknown,
        opts: unknown,
      ) => React.ReactNode
    }).renderToolResultMessage(parsed.data, [], {
      verbose: false,
    })
    expect(rendered).not.toBeNull()
    expect(rendered).not.toBeUndefined()
    expect(await renderText(rendered)).toContain('const a = 2')
  })
})
