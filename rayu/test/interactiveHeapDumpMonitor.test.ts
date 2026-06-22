import { afterEach, describe, expect, test } from 'bun:test'
import {
  AUTO_HEAPDUMP_THRESHOLD_BYTES,
  checkHeapForAutoDump,
  isAutoHeapDumpEnabled,
  _resetAutoHeapDumpStateForTest,
} from '../src/utils/interactiveHeapDumpMonitor.js'

const GB = 1024 * 1024 * 1024

describe('interactiveHeapDumpMonitor', () => {
  afterEach(() => {
    delete process.env.RAYU_AUTO_HEAPDUMP
    _resetAutoHeapDumpStateForTest()
  })

  test('enabled by default, opt-out via RAYU_AUTO_HEAPDUMP=0', () => {
    delete process.env.RAYU_AUTO_HEAPDUMP
    expect(isAutoHeapDumpEnabled()).toBe(true)
    process.env.RAYU_AUTO_HEAPDUMP = '0'
    expect(isAutoHeapDumpEnabled()).toBe(false)
    process.env.RAYU_AUTO_HEAPDUMP = 'false'
    expect(isAutoHeapDumpEnabled()).toBe(false)
  })

  test('does not dump below the 1.5GB threshold', async () => {
    let calls = 0
    const dumped = await checkHeapForAutoDump(
      () => 1.0 * GB,
      async () => {
        calls++
        return { success: true }
      },
    )
    expect(dumped).toBe(false)
    expect(calls).toBe(0)
  })

  test('dumps exactly once when heap crosses the threshold', async () => {
    let calls = 0
    const dump = async (
      _trigger: 'manual' | 'auto-1.5GB',
      dumpNumber: number,
    ): Promise<{ success: boolean; heapPath?: string }> => {
      calls++
      expect(_trigger).toBe('auto-1.5GB')
      expect(dumpNumber).toBe(1)
      return { success: true, heapPath: '/tmp/x.heapsnapshot' }
    }

    const first = await checkHeapForAutoDump(() => 2 * GB, dump)
    const second = await checkHeapForAutoDump(() => 2 * GB, dump)

    expect(first).toBe(true)
    expect(second).toBe(false) // capped — the guardrail fires once per session
    expect(calls).toBe(1)
  })

  test('threshold constant is 1.5GB', () => {
    expect(AUTO_HEAPDUMP_THRESHOLD_BYTES).toBe(1.5 * GB)
  })
})
