/**
 * Plan mode's rule: work like Full Manage, but leave the project unchanged.
 *
 * In plan mode the agent works without approval prompts, as in Full Manage: it reads,
 * searches, runs commands (tests, builds, scripts), asks questions, and writes its plan
 * to the session plan file. What it may not do is change the project, so these calls
 * are refused, with a message telling the model to put the change in the plan instead:
 *  - Edit and Write to any file except the session's plan files, and NotebookEdit;
 *  - shell commands that plainly change files or the repository: the file commands
 *    (rm, mv, cp, mkdir, touch, …), in-place sed and perl, output redirected into a
 *    file, `find -delete`, git commands that rewrite the working tree or history, and
 *    package-manager commands that add, remove or upgrade dependencies.
 *
 * The shell check reads the command line. It cannot see what a script or a build does
 * once it runs: the plan-mode instructions (utils/messages.ts) tell the model not to
 * change anything that way either, and this is the backstop for direct changes.
 * PowerShell command lines are not read this way, so only its read-only commands run.
 *
 * Unlike Orchestrator's rule (orchestrator/mainThreadPolicy.ts), this covers subagents
 * too: nothing spawned while planning may change the code.
 *
 * Checked first in hasPermissionsToUseToolInner and on the PreToolUse-hook allow path
 * (checkRuleBasedPermissions), so neither plan mode's allow nor a hook lets a change
 * through.
 */
import { tmpdir } from 'os'
import { basename, sep } from 'path'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import type { PermissionDenyDecision } from '../../types/permissions.js'
import { extractOutputRedirections, splitCommand_DEPRECATED } from '../bash/commands.js'
import { tryParseShellCommand } from '../bash/shellQuote.js'
import { expandPath } from '../path.js'
import { getPlanFilePath, isSessionPlanFile } from '../plans.js'

type PolicyTool = Pick<Tool, 'name' | 'inputSchema' | 'isReadOnly'>
type PolicyContext = Pick<ToolUseContext, 'agentId' | 'getAppState'>

/** The denial due for this call in plan mode, or null when the call may run. */
export function planModeChangeDenial(
  tool: PolicyTool,
  input: Record<string, unknown>,
  context: PolicyContext,
): PermissionDenyDecision | null {
  if (context.getAppState().toolPermissionContext.mode !== 'plan') return null
  const change = describePlanModeChange(tool, input)
  return change ? planModeDenial(change, context) : null
}

/** What the call would change that plan mode refuses, or null. Exported for tests. */
export function describePlanModeChange(
  tool: PolicyTool,
  input: Record<string, unknown>,
): string | null {
  if (tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) {
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    return path && isSessionPlanFile(expandPath(path)) ? null : 'edit files other than the plan'
  }
  if (tool.name === NOTEBOOK_EDIT_TOOL_NAME) return 'edit notebooks'
  if (tool.name !== BASH_TOOL_NAME && tool.name !== POWERSHELL_TOOL_NAME) return null
  if (isReadOnlyCall(tool, input)) return null
  if (tool.name === POWERSHELL_TOOL_NAME) return 'run PowerShell commands that can change files'
  const command = typeof input.command === 'string' ? input.command : ''
  return shellCommandChangesFiles(command)
    ? 'run commands that change files or the repository'
    : null
}

/** Input the schema rejects is treated as not read-only: the safe answer. */
function isReadOnlyCall(tool: PolicyTool, input: Record<string, unknown>): boolean {
  const parsed = tool.inputSchema.safeParse(input)
  return parsed.success && tool.isReadOnly(parsed.data)
}

function planModeDenial(change: string, context: PolicyContext): PermissionDenyDecision {
  return {
    behavior: 'deny',
    message: `Plan mode: you are planning, so you may not ${change}. Write the change into the plan file (${getPlanFilePath(context.agentId)}) instead; it is carried out after the user approves the plan and plan mode ends. Reading, searching and commands that do not change files are still available.`,
    decisionReason: { type: 'mode', mode: 'plan' },
  }
}

// ── reading a shell command line ───────────────────────────────────────────────

/** Redirect targets that are not project files: devices, and the temp folder. */
const HARMLESS_REDIRECT_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

function isHarmlessRedirectTarget(target: string): boolean {
  if (HARMLESS_REDIRECT_TARGETS.has(target)) return true
  // Saving output to a temp file (`git diff > /tmp/x.patch`) cannot change the code.
  const temp = [`/tmp${sep}`, `${tmpdir()}${sep}`]
  return !target.includes('..') && temp.some(dir => target.startsWith(dir))
}

/** Whether a shell command line plainly changes files or the repository. */
export function shellCommandChangesFiles(command: string): boolean {
  const { redirections, hasDangerousRedirection } = extractOutputRedirections(command)
  // A target that could not be read (a variable, a substitution) may be any file.
  if (hasDangerousRedirection) return true
  if (redirections.some(redirect => !isHarmlessRedirectTarget(redirect.target))) {
    return true
  }
  return splitCommand_DEPRECATED(command).some(subcommandChangesFiles)
}

/** Commands whose job is changing files. */
const FILE_CHANGING_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'mv', 'cp', 'ln', 'install', 'mkdir', 'touch',
  'truncate', 'tee', 'dd', 'rsync', 'patch', 'chmod', 'chown', 'chgrp',
])

function subcommandChangesFiles(subcommand: string): boolean {
  const argv = commandWords(subcommand)
  // A command that cannot be read is assumed to change files: the safe answer.
  if (!argv) return true
  const [name, ...args] = argv
  if (!name) return false
  const command = basename(name)
  if (FILE_CHANGING_COMMANDS.has(command)) return true
  switch (command) {
    case 'sed':
      return hasInPlaceFlag(args, true)
    case 'perl':
      return hasInPlaceFlag(args, false)
    case 'find':
      return findChangesFiles(args)
    case 'git':
      return gitChangesRepository(args)
    default:
      return packageManagerChangesDependencies(command, args)
  }
}

/** The words of one simple command, with assignments and wrappers removed; null if unreadable. */
function commandWords(subcommand: string): string[] | null {
  const parsed = tryParseShellCommand(subcommand, name => `$${name}`)
  if (!parsed.success) return null
  const words = parsed.tokens.flatMap(token => {
    if (typeof token === 'string') return [token]
    return 'pattern' in token && typeof token.pattern === 'string' ? [token.pattern] : []
  })
  let start = 0
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!)) start++
  return unwrap(words.slice(start))
}

/** Commands that run the command after them, and their flags that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a']),
  nohup: new Set(),
  time: new Set(),
  command: new Set(),
  exec: new Set(),
  stdbuf: new Set(),
}

/** The wrapped command: `sudo -u x rm f`, `env A=1 rm f`, `timeout 5 rm f` → `rm f`. */
function unwrap(words: string[]): string[] {
  let rest = words
  while (rest.length > 0 && Object.hasOwn(WRAPPERS, basename(rest[0]!))) {
    const valueFlags = WRAPPERS[basename(rest[0]!)]!
    const isTimeout = basename(rest[0]!) === 'timeout'
    let i = 1
    while (i < rest.length) {
      const word = rest[i]!
      if (valueFlags.has(word)) i += 2
      else if (word.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i += 1
      else break
    }
    // timeout's duration comes before the command.
    if (isTimeout && i < rest.length) i += 1
    rest = rest.slice(i)
  }
  return rest
}

/**
 * `sed -i`, `sed -Ei`, `sed --in-place`, `perl -pi -e …`, `perl -i.bak …`. For sed, an
 * `i` inside a short-flag cluster is in-place; perl spells it the same way.
 */
function hasInPlaceFlag(args: readonly string[], longForm: boolean): boolean {
  return args.some(arg =>
    (longForm && (arg === '--in-place' || arg.startsWith('--in-place='))) ||
    /^-[A-Za-z]*i/.test(arg),
  )
}

/** `find -delete`, or `find -exec`/`-execdir`/`-ok` running a file-changing command. */
function findChangesFiles(args: readonly string[]): boolean {
  return args.some((arg, i) => {
    if (arg === '-delete') return true
    if (arg !== '-exec' && arg !== '-execdir' && arg !== '-ok' && arg !== '-okdir') return false
    const run = args[i + 1]
    return run !== undefined && subcommandChangesFiles(args.slice(i + 1).join(' '))
  })
}

/** git subcommands that change the working tree, the index, history or a remote. */
const GIT_CHANGING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'init',
  'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash',
  'submodule', 'switch', 'worktree',
])

/** Second words that only read: `git stash list`, `git worktree list`, … */
const GIT_READING_SECOND_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list']),
  submodule: new Set(['status', 'summary']),
}

/** git's options that take a value before the subcommand. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path',
])

function gitChangesRepository(args: readonly string[]): boolean {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    i += GIT_VALUE_OPTIONS.has(args[i]!) ? 2 : 1
  }
  const subcommand = args[i]
  if (!subcommand || !GIT_CHANGING_SUBCOMMANDS.has(subcommand)) return false
  const second = args.slice(i + 1).find(word => !word.startsWith('-'))
  return !(second !== undefined && GIT_READING_SECOND_WORDS[subcommand]?.has(second))
}

const JS_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Subcommands that change the dependency list or the installed versions. */
const DEPENDENCY_CHANGING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'upgrade', 'up', 'link', 'unlink',
])

/** `npm install left-pad`, `bun add x`, `pip install x` — but a bare `npm install` runs. */
function packageManagerChangesDependencies(command: string, args: readonly string[]): boolean {
  const [subcommand, ...rest] = args.filter(arg => !arg.startsWith('-'))
  if (!subcommand) return false
  if (command === 'pip' || command === 'pip3') {
    return subcommand === 'install' || subcommand === 'uninstall'
  }
  if (!JS_PACKAGE_MANAGERS.has(command)) return false
  if (DEPENDENCY_CHANGING_SUBCOMMANDS.has(subcommand)) return true
  return (subcommand === 'install' || subcommand === 'i') && rest.length > 0
}
