# RAYU Tool Failure Report

**Date:** 2026-06-04  
**Overall:** 18/21 tools working (85.7%) — 2 critical failures

---

## Failed Tool #1: Grep

**Error:**
```
spawn /home/rayu/rayu-cli/rayu/dist/vendor/ripgrep/x64-linux/rg ENOENT
```

**Why it fails:**  
The Grep tool hardcodes a path to a vendored ripgrep binary at `dist/vendor/ripgrep/x64-linux/rg`. That file doesn't exist. System ripgrep is installed at `/usr/bin/rg` (v14.1.1) but the tool ignores it.

**Root cause:**  
The build process (`scripts/build.ts`) doesn't copy the ripgrep binary into the vendor directory, or it was never configured to do so in this fork.

**Suggestion:**  
Add a fallback to system `rg` when the vendored binary is missing:
```typescript
const vendorPath = path.join(__dirname, 'vendor/ripgrep/x64-linux/rg');
const rgPath = fs.existsSync(vendorPath) ? vendorPath : 'rg';
```

**Workaround:** Use `Bash` tool with `rg` command directly.

---

## Failed Tool #2: TaskOutput / TaskStop

**Error:**
```
No task found with ID: 1
```

**Why it fails:**  
Tasks are stored in directories keyed by `taskListId` (from `src/utils/tasks.ts:199-210`). The `taskListId` is computed dynamically from session context:

```typescript
export function getTaskListId(): string {
  return process.env.CLAUDE_CODE_TASK_LIST_ID 
    || getTeammateContext()?.teamName 
    || getTeamName() 
    || leaderTeamName 
    || getSessionId();
}
```

When TaskCreate runs, it saves to `~/.claude/tasks/<sessionA>/1.json`. When TaskOutput runs later, the context may resolve to a different `taskListId`, so it looks in `~/.claude/tasks/<sessionB>/1.json` — file not found.

**Root cause:**  
No stable binding between a created task and its storage location. The `taskListId` can change between tool invocations due to session rotation, teammate context changes, or environment variable shifts.

**Suggestion:**  
Return the full qualified task reference from TaskCreate (e.g., `taskListId:taskId`) so TaskOutput can resolve the correct directory. Or search all known task directories as a fallback.

**Workaround:** Use `TaskList` to see tasks (works because it reads from the current context).

---

## Failed Tool #3: TaskStop (secondary)

Same root cause as TaskOutput — it can't find the task by ID. Fixing TaskOutput fixes TaskStop.

---

## Summary Table

| Tool | Status | Root Cause |
|------|--------|-----------|
| Grep | FAIL | Vendored ripgrep binary missing, no system fallback |
| TaskOutput | FAIL | Task context (taskListId) diverges between tool calls |
| TaskStop | BLOCKED | Depends on TaskOutput's broken lookup |
