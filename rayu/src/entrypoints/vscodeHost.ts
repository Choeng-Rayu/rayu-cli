/**
 * `vscodeHost` — the engine entrypoint the Rayucode VS Code extension spawns.
 *
 * NOTE: deliberately NO `#!/usr/bin/env node` here. `scripts/build-vscode-host.ts`
 * adds it as the bundle banner, exactly as the CLI build does for `cli.tsx`;
 * having it in both places emits it twice and Node then fails to parse the file
 * ("Invalid or unexpected token" on line 2).
 *
 * WHY THIS EXISTS
 * The extension previously spawned the published CLI binary and hand-assembled
 * the headless flags itself (`rayucode/packages/core/src/cli/agentProcess.ts`).
 * That made the flag set a contract duplicated in another repository: the
 * extension had to know that `stream-json` output requires `--verbose`, that
 * input must also be `stream-json`, and that `--print` is what selects headless
 * mode at all. Any change to that contract broke a consumer that could not see
 * it. This entrypoint owns the contract on the engine side, where it belongs.
 *
 * WHY IT DELEGATES INSTEAD OF REBUILDING
 * The headless setup — the tool registry, the ~98 slash commands, skills, MCP
 * clients, agent definitions, app state — is assembled in `src/main.tsx` before
 * it calls `runHeadless()` (main.tsx:2681). Reassembling any of that here would
 * create a second, drifting definition of "what the engine can do", which is the
 * exact failure this whole migration exists to remove. So this file normalises
 * `process.argv` and hands off to the SAME `main()` that `cli.tsx` calls.
 *
 * The consequence is the property the extension needs: it gets every tool,
 * command, skill and MCP server the CLI has, because it is running the CLI's
 * code with a fixed set of flags — not a reimplementation.
 *
 * WHAT IT DOES NOT DO
 * No React, no Ink, no terminal UI. `--print` selects the headless path, so the
 * TUI is never constructed. Tool execution stays in THIS process, off the
 * extension host's thread, which is why the extension spawns it rather than
 * importing the engine: tools spawn processes, write files and reach native
 * dependencies, and `src/tools.ts` transitively reaches the React UI.
 *
 * Built by `scripts/build-vscode-host.ts` with the same `sharedBuildOptions()`
 * the CLI bundle uses — mandatory, because rayu is built from partial source and
 * several `require()`d modules only disappear when a `--define` folds a branch to
 * a constant.
 */
import { loadDotEnv } from '../utils/envUtils.js'

// Load .env before anything else runs, matching cli.tsx. A workspace .env is how
// a developer points the engine at a local backend, and the extension forwards
// its own resolved environment on top.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
loadDotEnv()

// Corepack auto-pinning adds yarnpkg to package.json files it touches. Same
// guard cli.tsx installs.
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

/**
 * The flags that define headless, bidirectional, streaming operation.
 *
 * `--verbose` is not optional: `print.ts` rejects `--output-format=stream-json`
 * without it ("When using --print, --output-format=stream-json requires
 * --verbose"). Encoding that here means a consumer cannot get it wrong.
 *
 * `--permission-prompt-tool stdio` is what makes permission requests REACH the
 * host, and its absence was a real bug. `getCanUseToolFn` in print.ts branches
 * three ways:
 *
 *   'stdio'    → structuredIO.createCanUseTool(), i.e. send a `can_use_tool`
 *                control request and wait for the host's decision;
 *   undefined  → decide LOCALLY via hasPermissionsToUseTool();
 *   <mcp tool> → delegate to a named MCP tool.
 *
 * The extension spawned the engine without it, so the engine took the `undefined`
 * branch and resolved every permission by itself. The panel then reported that a
 * tool needed permission while never being asked for one — the user saw "it needs
 * permission" and had nothing to approve. `stdio` is the value the SDK path forces
 * for exactly this reason (`options.sdkUrl ? 'stdio' : ...`).
 */
const REQUIRED_FLAGS = [
  '--print',
  '--input-format=stream-json',
  '--output-format=stream-json',
  '--verbose',
  '--permission-prompt-tool=stdio',
] as const

/**
 * Merge the required flags into the caller's argv without duplicating them.
 *
 * Duplicates are avoided rather than tolerated: Commander accepts a repeated
 * boolean but a repeated `--output-format` would be ambiguous, and the extension
 * may legitimately pass its own `--model`, `--resume`, `--permission-mode` or
 * `--add-dir`, which must survive untouched.
 *
 * Exported for tests — the argv contract is the whole of this file's logic.
 */
export function buildHostArgv(passthrough: readonly string[]): string[] {
  const out = [...passthrough]
  for (const flag of REQUIRED_FLAGS) {
    const name = flag.split('=')[0] as string
    const already = out.some(arg => arg === name || arg.startsWith(`${name}=`))
    if (!already) out.push(flag)
  }
  return out
}

async function main(): Promise<void> {
  // process.argv is [node, thisScript, ...args]; main() re-reads process.argv,
  // so the merged flags have to be written back into it rather than passed.
  const passthrough = process.argv.slice(2)
  process.argv = [
    process.argv[0] as string,
    process.argv[1] as string,
    ...buildHostArgv(passthrough),
  ]

  const { main: cliMain } = await import('../main.js')
  await cliMain()
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main()
