/**
 * Task 6: the per-agent change ledger, extracted from the external-agents change
 * tracker so Orchestrator mode can keep one per run. The tracker's own behavior stays
 * covered by test/externalAgentsPlanning.test.ts and the other externalAgents suites.
 */
import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import { createAgentChangeLedger, resolveChangePath } from '../src/utils/agentChangeLedger.ts'

const ROOT = resolve('/work/app')
const at = (n: number) => 1_000 + n

describe('createAgentChangeLedger', () => {
  test('folds repeated changes to one path and keeps the first kind', () => {
    const ledger = createAgentChangeLedger()
    ledger.record({ agentId: 'types', path: 'src/types/user.ts', change: 'created', at: at(1) }, ROOT)
    ledger.record({ agentId: 'types', path: join(ROOT, 'src/types/user.ts'), change: 'modified', at: at(2), hasDiff: true }, ROOT)
    expect(ledger.listChangedFiles('types')).toEqual([
      {
        path: join(ROOT, 'src/types/user.ts'),
        displayPath: join('src', 'types', 'user.ts'),
        change: 'modified',
        firstChange: 'created',
        firstSeenMs: at(1),
        lastSeenMs: at(2),
        count: 2,
        hasDiff: true,
      },
    ])
  })

  test('reports a path two agents changed, most recent writer first', () => {
    const ledger = createAgentChangeLedger()
    ledger.record({ agentId: 'types', path: 'src/types/user.ts', change: 'modified', at: at(1) }, ROOT)
    ledger.record({ agentId: 'ui', path: 'src/types/user.ts', change: 'modified', at: at(5) }, ROOT)
    ledger.record({ agentId: 'api', path: 'src/api/userApi.ts', change: 'modified', at: at(3) }, ROOT)
    const conflicts = ledger.findConflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.agents.map(agent => agent.agentId)).toEqual(['ui', 'types'])
    expect(ledger.findConflictsForAgent('api')).toEqual([])
    expect(ledger.findConflictsForAgent('types')).toEqual(conflicts)
  })

  test('agents in different worktrees never conflict', () => {
    const ledger = createAgentChangeLedger()
    ledger.record({ agentId: 'a', path: 'src/x.ts', change: 'modified', at: at(1) }, resolve('/work/wt-a'))
    ledger.record({ agentId: 'b', path: 'src/x.ts', change: 'modified', at: at(2) }, resolve('/work/wt-b'))
    expect(ledger.findConflicts()).toEqual([])
  })

  test('paths that differ only in case are one file when configured', () => {
    const sensitive = createAgentChangeLedger()
    const insensitive = createAgentChangeLedger({ caseInsensitivePaths: true })
    for (const ledger of [sensitive, insensitive]) {
      ledger.record({ agentId: 'a', path: 'src/User.ts', change: 'modified', at: at(1) }, ROOT)
      ledger.record({ agentId: 'b', path: 'src/user.ts', change: 'modified', at: at(2) }, ROOT)
    }
    expect(sensitive.findConflicts()).toEqual([])
    const conflicts = insensitive.findConflicts()
    expect(conflicts).toHaveLength(1)
    // The first-seen spelling is kept for display.
    expect(conflicts[0]!.path).toBe(join(ROOT, 'src/User.ts'))
  })

  test('caps distinct paths per agent and counts the overflow', () => {
    const ledger = createAgentChangeLedger({ maxPathsPerAgent: 2 })
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
      ledger.record({ agentId: 'w', path: name, change: 'created', at: at(1) }, ROOT)
    }
    // A path already tracked still folds in after the cap.
    ledger.record({ agentId: 'w', path: 'a.ts', change: 'modified', at: at(2) }, ROOT)
    expect(ledger.getSummary('w')?.files).toHaveLength(2)
    expect(ledger.getSummary('w')?.overflowCount).toBe(2)
    expect(ledger.hasPartialCoverage()).toBe(true)
  })

  test('ledgers are independent, and clear/reset forget agents', () => {
    const one = createAgentChangeLedger()
    const two = createAgentChangeLedger()
    one.record({ agentId: 'w', path: 'a.ts', change: 'created', at: at(1) }, ROOT)
    expect(two.listSummaries()).toEqual([])
    one.clearAgent('w')
    expect(one.getSummary('w')).toBeUndefined()
    one.record({ agentId: 'w', path: 'a.ts', change: 'created', at: at(1) }, ROOT)
    one.reset()
    expect(one.listSummaries()).toEqual([])
  })

  test('resolveChangePath keeps absolute paths and anchors relative ones', () => {
    expect(resolveChangePath(join(ROOT, 'x', '..', 'y.ts'), ROOT)).toBe(join(ROOT, 'y.ts'))
    expect(resolveChangePath('src/y.ts', ROOT)).toBe(join(ROOT, 'src', 'y.ts'))
  })
})
