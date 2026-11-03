import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { z } from 'zod/v4'
import { getEmptyToolPermissionContext } from 'src/Tool'
import { hasPermissionsToUseToolInner } from 'src/utils/permissions/permissions'
import {
  describePlanModeChange,
  planModeChangeDenial,
  shellCommandChangesFiles,
} from 'src/utils/permissions/planModePolicy'
import { getPlanFilePath } from 'src/utils/plans'

// Plan mode works like Full Manage (no approval prompts) but leaves the project
// unchanged: edits outside the plan file, and shell commands that plainly change files
// or the repository, are refused. See src/utils/permissions/planModePolicy.ts.

function ctx(toolPermissionContext: Record<string, unknown>, agentId?: string) {
  return {
    abortController: new AbortController(),
    agentId,
    options: { tools: [] },
    getAppState: () => ({
      toolPermissionContext: { ...getEmptyToolPermissionContext(), ...toolPermissionContext },
    }),
  } as unknown as Parameters<typeof hasPermissionsToUseToolInner>[2]
}

/** A tool that asks, like Edit or Bash outside the working rules. */
function tool(name: string, options: { readOnly?: boolean; interactive?: boolean } = {}) {
  return {
    name,
    mcpInfo: undefined,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => options.readOnly ?? false,
    requiresUserInteraction: () => options.interactive ?? false,
    async checkPermissions(input: Record<string, unknown>) {
      return { behavior: 'ask' as const, message: `${name}?`, updatedInput: input }
    },
  } as never
}

const plan = ctx({ mode: 'plan', isBypassPermissionsModeAvailable: true })
const check = (t: never, input: Record<string, unknown>, context = plan) =>
  hasPermissionsToUseToolInner(t, input, context)

describe('plan mode runs like Full Manage', () => {
  it('runs a command that changes nothing without asking', async () => {
    const res = await check(tool('Bash'), { command: 'bun test test/foo.test.ts' })
    expect(res.behavior).toBe('allow')
    expect(res.decisionReason).toMatchObject({ type: 'mode', mode: 'plan' })
  })

  it('runs without asking even when bypass is not available (the CLI default)', async () => {
    const res = await check(tool('Bash'), { command: 'ls -la' }, ctx({ mode: 'plan', isBypassPermissionsModeAvailable: false }))
    expect(res.behavior).toBe('allow')
  })

  it('writes the plan file without asking', async () => {
    const res = await check(tool('Write'), { file_path: getPlanFilePath(), content: '# Plan' })
    expect(res.behavior).toBe('allow')
  })

  it('still asks for tools that need the user (AskUserQuestion, ExitPlanMode)', async () => {
    const res = await check(tool('ExitPlanMode', { interactive: true }), {})
    expect(res.behavior).toBe('ask')
  })

  it('runs other tools (web, MCP, search) without asking', async () => {
    expect((await check(tool('WebFetch'), { url: 'https://example.com' })).behavior).toBe('allow')
    expect((await check(tool('mcp__db__query'), { sql: 'select 1' })).behavior).toBe('allow')
  })
})

describe('plan mode does not change the project', () => {
  it.each(['Edit', 'Write'])('refuses %s outside the plan file', async name => {
    const res = await check(tool(name), { file_path: '/repo/src/index.ts' })
    expect(res.behavior).toBe('deny')
    expect(res.decisionReason).toMatchObject({ type: 'mode', mode: 'plan' })
    expect((res as { message: string }).message).toContain(getPlanFilePath())
  })

  it('refuses a path that only looks like the plan file', async () => {
    const plansDir = join(getPlanFilePath(), '..')
    const res = await check(tool('Write'), { file_path: join(plansDir, '..', 'escape.md') })
    expect(res.behavior).toBe('deny')
  })

  it('refuses NotebookEdit', async () => {
    expect((await check(tool('NotebookEdit'), { notebook_path: '/repo/a.ipynb' })).behavior).toBe('deny')
  })

  it('refuses a shell command that changes files', async () => {
    const res = await check(tool('Bash'), { command: 'rm -rf src' })
    expect(res.behavior).toBe('deny')
  })

  it('refuses a non-read-only PowerShell command', async () => {
    expect((await check(tool('PowerShell'), { command: 'Remove-Item x' })).behavior).toBe('deny')
    expect((await check(tool('PowerShell', { readOnly: true }), { command: 'Get-ChildItem' })).behavior).toBe('allow')
  })

  it('covers subagents too, unlike Orchestrator', () => {
    const denial = planModeChangeDenial(tool('Edit'), { file_path: '/repo/a.ts' }, ctx({ mode: 'plan' }, 'agent-1') as never)
    expect(denial?.behavior).toBe('deny')
    expect(denial?.message).toContain(getPlanFilePath('agent-1' as never))
  })

  it('does nothing outside plan mode', () => {
    for (const mode of ['default', 'acceptEdits', 'fullManage', 'bypassPermissions']) {
      expect(planModeChangeDenial(tool('Edit'), { file_path: '/repo/a.ts' }, ctx({ mode }) as never)).toBeNull()
    }
  })
})

describe('other modes are unchanged', () => {
  it('default asks before a change', async () => {
    const res = await check(tool('Bash'), { command: 'rm x' }, ctx({ mode: 'default', isBypassPermissionsModeAvailable: true }))
    expect(res.behavior).toBe('ask')
  })

  it('bypassPermissions allows a change', async () => {
    const res = await check(tool('Bash'), { command: 'rm x' }, ctx({ mode: 'bypassPermissions', isBypassPermissionsModeAvailable: true }))
    expect(res.behavior).toBe('allow')
  })
})

describe('describePlanModeChange', () => {
  it('lets read-only shell calls through without reading the command', () => {
    expect(describePlanModeChange(tool('Bash', { readOnly: true }), { command: 'rm -rf /' })).toBeNull()
  })

  it('ignores tools that cannot change the project', () => {
    expect(describePlanModeChange(tool('Read'), { file_path: '/repo/a.ts' })).toBeNull()
    expect(describePlanModeChange(tool('Grep'), { pattern: 'x' })).toBeNull()
  })
})

describe('shellCommandChangesFiles', () => {
  it.each([
    'rm -rf build',
    'mv a.ts b.ts',
    'cp src/a.ts src/b.ts',
    'mkdir new-dir',
    'touch file.txt',
    'chmod +x run.sh',
    'echo hi > notes.txt',
    'cat a >> b',
    'echo $(date) > "$OUT"',
    'sed -i "s/a/b/" src/a.ts',
    'sed -Ei "s/a/b/" src/a.ts',
    'sed --in-place=.bak s/a/b/ src/a.ts',
    'perl -pi -e "s/a/b/" src/a.ts',
    'find . -name "*.log" -delete',
    'find . -name "*.ts" -exec rm {} +',
    'git checkout -- src/a.ts',
    'git commit -m "wip"',
    'git -C repo reset --hard',
    'git stash',
    'git push origin main',
    'npm install left-pad',
    'bun add zod',
    'pnpm remove react',
    'pip install requests',
    'sudo rm /etc/hosts',
    'env FOO=1 rm x',
    'timeout 5 rm x',
    'FOO=bar mv a b',
    'ls && rm x',
    'cat a.txt | tee b.txt',
    'xargs rm < files.txt',
    '/bin/rm x',
  ])('%p changes files', command => {
    expect(shellCommandChangesFiles(command)).toBe(true)
  })

  it.each([
    'ls -la',
    'cat package.json',
    'grep -rn TODO src',
    'bun test',
    'npm install',
    'npm run build',
    'node scripts/check.js',
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git stash list',
    'git worktree list',
    'sed -n "1,20p" src/a.ts',
    'find . -name "*.ts"',
    'echo done > /dev/null',
    'bun test 2>/dev/null',
    'git diff > /tmp/change.patch',
    'bun test 2>&1 | tail -20',
    'git fetch origin',
    'npm ci',
    'curl -s https://example.com',
    'python3 -c "print(1)"',
  ])('%p does not', command => {
    expect(shellCommandChangesFiles(command)).toBe(false)
  })

  it('a redirect that climbs out of the temp folder still counts as a change', () => {
    expect(shellCommandChangesFiles('echo x > /tmp/../repo/src/a.ts')).toBe(true)
  })
})
