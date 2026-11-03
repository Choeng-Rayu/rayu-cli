/**
 * The one place that knows which adapters exist.
 *
 * Registration is an explicit call, never a module side effect. A self-
 * registering adapter module would have to be imported for its side effect,
 * which defeats `feature('EXTERNAL_AGENTS')` dead-code elimination and would
 * pull three CLIs' protocol code into every bundle.
 *
 * Idempotent, so every entry point (the `/agent` command, the tool, the recovery
 * path) can call it without coordinating.
 */

import { createClaudeCodeAdapter } from './claudeCode/ClaudeCodeAdapter.js'
import { createCodexAdapter } from './codex/CodexAdapter.js'
import { createOpenCodeAdapter } from './opencode/OpenCodeAdapter.js'
import {
  createAcpAdapter,
  readDeclaredAcpAgents,
} from './acp/AcpAdapter.js'
import {
  findAdapter,
  registerAdapter,
} from '../core/adapterRegistry.js'
import { asProviderId } from '../core/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { CODEX_PROVIDER } from './codex/CodexAdapter.js'
import { CLAUDE_CODE_PROVIDER } from './claudeCode/ClaudeCodeAdapter.js'
import { OPENCODE_PROVIDER } from './opencode/OpenCodeAdapter.js'

/**
 * Register every built-in adapter, plus any ACP agent the user declared.
 *
 * Safe to call repeatedly: an already-registered provider is skipped rather than
 * replaced, so a second call cannot swap the adapter out from under a live
 * handle that was created by the first.
 */
export function registerAdapters(): void {
  if (!findAdapter(CODEX_PROVIDER)) registerAdapter(createCodexAdapter())
  if (!findAdapter(CLAUDE_CODE_PROVIDER)) {
    registerAdapter(createClaudeCodeAdapter())
  }
  if (!findAdapter(OPENCODE_PROVIDER)) registerAdapter(createOpenCodeAdapter())
  registerDeclaredAcpAgents()
}

/**
 * Register ACP agents declared in the environment.
 *
 * ACP is a protocol, not a product, so there is no fixed list to ship. A
 * declared provider that collides with a built-in is SKIPPED rather than
 * allowed to shadow it — silently replacing the Codex adapter because someone
 * named their ACP agent "codex" would be very hard to diagnose.
 */
export function registerDeclaredAcpAgents(): void {
  for (const config of readDeclaredAcpAgents()) {
    const provider = asProviderId(config.provider)
    if (findAdapter(provider)) {
      logForDebugging(
        `[acp] declared agent "${config.provider}" collides with an already-registered provider; skipping it`,
        { level: 'warn' },
      )
      continue
    }
    registerAdapter(createAcpAdapter(config))
  }
}
