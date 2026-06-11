import type { Command } from '../../commands.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getDefaultBranch, getIsGit, gitExe } from '../../utils/git.js'

// Local, provider-agnostic /ultrareview. Unlike the remote "RAYU on the web"
// ultrareview (Anthropic remote bughunter), this runs entirely on the user's
// configured provider by injecting a deep bug-hunt directive — the main agent
// dispatches review subagents over the branch diff, then verifies and reports
// findings. Modeled on src/commands/swarm.ts.

// ~20k tokens worth of unified diff. Beyond this we truncate so the changeset
// never blows the context window; the model is told to inspect the rest via git.
const MAX_DIFF_CHARS = 80_000
const GIT_TIMEOUT_MS = 15_000

/**
 * Gather the current branch's changeset (committed + uncommitted) vs the
 * merge-base with the default branch, as a raw unified diff. Pre-gathering this
 * here makes the review deterministic instead of relying on the model to run
 * git itself (which weaker models may skip or hallucinate).
 *
 * Returns:
 *  - the diff string when there are changes,
 *  - '' when the branch has no changes vs base,
 *  - null when not in a git repo or git failed (caller falls back to letting
 *    the model gather the diff via Bash).
 */
async function gatherBranchDiff(): Promise<string | null> {
  try {
    if (!(await getIsGit())) return null
    const base = await getDefaultBranch()

    // Prefer the merge-base so we only review what this branch added, not
    // unrelated commits already on base. Fall back to base itself if merge-base
    // can't be resolved (e.g. unrelated histories).
    let baseRef = base
    const mb = await execFileNoThrow(
      gitExe(),
      ['merge-base', 'HEAD', base],
      { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
    )
    if (mb.code === 0 && mb.stdout.trim()) {
      baseRef = mb.stdout.trim()
    }

    // `git diff <ref>` compares the working tree (staged + unstaged + committed)
    // against <ref> — the full set of changes on this branch.
    const diff = await execFileNoThrow(
      gitExe(),
      ['--no-optional-locks', 'diff', baseRef],
      { timeout: GIT_TIMEOUT_MS, preserveOutputOnError: false },
    )
    if (diff.code !== 0) return null

    let text = diff.stdout
    if (!text.trim()) return ''
    if (text.length > MAX_DIFF_CHARS) {
      text =
        text.slice(0, MAX_DIFF_CHARS) +
        `\n\n... [diff truncated at ${MAX_DIFF_CHARS} characters. Inspect the remaining/largest changed files directly with \`git diff ${baseRef} -- <path>\`; consider committing in smaller chunks for a tighter review.]`
    }
    return text
  } catch {
    return null
  }
}

const HOW_TO = `## How to ultrareview
1. Establish exactly which files and hunks changed, and group them by concern.
2. Hunt IN PARALLEL. In a SINGLE message, dispatch multiple subagents via the Agent tool to review different areas/concerns concurrently. Cover: correctness & logic errors, edge cases & error handling, security (use the SEC specialist for auth/input-handling/secrets), performance, and test coverage gaps. Use the Explore / general-purpose agents to read the actual changed files and trace how the changed code is used elsewhere — the diff alone is not enough context.
3. VERIFY every candidate bug before reporting it: trace the actual code path, check callers/usages, and confirm it's a genuine defect — discard false positives and anything that's merely stylistic.
4. Report a single prioritized list. For each finding: severity (critical / high / medium / low), \`file:line\`, a concise explanation of the bug and how it triggers, and a concrete suggested fix. If you found no verified bugs, say so plainly rather than inventing issues.`

const command = {
  type: 'prompt',
  name: 'ultrareview',
  description:
    'Deep bug-hunt on your branch: parallel review subagents find and verify bugs — runs locally on your provider',
  argumentHint: '[PR number, or empty for current branch]',
  contentLength: 0,
  progressMessage: 'running deep multi-agent bug-hunt',
  source: 'builtin',
  async getPromptForCommand(args: string) {
    const pr = (args ?? '').trim()

    // PR review: let the model fetch the PR diff via gh (auth/network needed).
    if (pr) {
      return [
        {
          type: 'text' as const,
          text: `You are now in ULTRAREVIEW mode — a deep, multi-agent bug-hunt. Find real, verified bugs in the changed code. This is a review only: do NOT modify code.

## Scope
Review pull request #${pr}. First run \`gh pr diff ${pr}\` to get the diff and \`gh pr view ${pr}\` for context, and establish exactly which files/hunks changed before reviewing.

${HOW_TO}

Begin by gathering the PR diff, then state your parallel review dispatch.`,
        },
      ]
    }

    // Current branch: pre-gather the diff so the review is deterministic.
    const diff = await gatherBranchDiff()

    if (diff === '') {
      return [
        {
          type: 'text' as const,
          text: `ULTRAREVIEW: there are no changes on the current branch relative to its base, so there is nothing to review. If you expected changes, tell the user you found an empty diff and ask whether they want to review a specific PR number or a different base.`,
        },
      ]
    }

    const scopeSection =
      diff === null
        ? `## Scope
Review the current branch. Determine the diff against the base branch yourself: find the merge-base (try \`git merge-base HEAD origin/main\` / \`origin/master\`, falling back to \`main\`/\`master\`) and run \`git diff <merge-base>\` (this includes committed and uncommitted changes). Establish exactly which files/hunks changed before reviewing.`
        : `## Scope
Review the current branch. The changeset (committed + uncommitted, vs the merge-base with the default branch) has already been gathered for you below — treat it as the authoritative list of what changed, and use subagents to read the actual files for full context.

<branch_diff>
${diff}
</branch_diff>`

    const opener =
      diff === null
        ? 'Begin by gathering the diff, then state your parallel review dispatch.'
        : 'Begin by grouping the changed files from the diff above, then state your parallel review dispatch.'

    return [
      {
        type: 'text' as const,
        text: `You are now in ULTRAREVIEW mode — a deep, multi-agent bug-hunt. Find real, verified bugs in the changed code. This is a review only: do NOT modify code.

${scopeSection}

${HOW_TO}

${opener}`,
      },
    ]
  },
} satisfies Command

export default command
