// Stub for a feature-gated module that was not included in the leaked source.
//
// The original postCommitAttribution lives behind the disabled
// `COMMIT_ATTRIBUTION` feature flag (see scripts/macroValues.ts →
// ENABLED_FEATURES). worktree.ts loads it as
// `feature('COMMIT_ATTRIBUTION') && import('./postCommitAttribution.js')`, so
// Bun dead-code-eliminates it from the build — this file is never bundled or
// executed. It exists only so `tsc` can resolve the dynamic-import type query.
//
// If COMMIT_ATTRIBUTION is ever enabled, replace this with the real
// implementation (installs a prepare-commit-msg hook that appends the
// Co-Authored-By trailer to commits made inside a worktree).
export function installPrepareCommitMsgHook(
  _worktreePath: string,
  _worktreeHooksDir?: string,
): Promise<void> {
  return Promise.resolve()
}
