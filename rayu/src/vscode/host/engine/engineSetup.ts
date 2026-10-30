/**
 * Resolve this window's engine at activation — the editor-facing half of
 * `engineLaunch.ts`, `engineMemoryLimit.ts` and `ripgrepLocation.ts`, which hold the
 * decisions and stay free of `vscode`.
 *
 * The engine is resolved ONCE per window. Every conversation and helper child shares
 * the result, so two conversations in one window can never run different engines.
 * Changing `rayucode.engine.path` or `rayucode.engine.maxMemoryMB` therefore asks for a
 * window reload instead of changing engines under conversations that are already running.
 */
import * as vscode from 'vscode'

import {
  ENGINE_PATH_SETTING,
  ensureEngineExecutable,
  ensureExecutableFile,
  resolveEngineLaunch,
  withLaunchEnv,
  type EngineLaunch,
} from './engineLaunch.js'
import {
  MEMORY_LIMIT_SETTING,
  resolveMemoryLimit,
  type MemoryLimit,
} from './engineMemoryLimit.js'
import { resolveRipgrep, type RipgrepLocation } from './ripgrepLocation.js'

export interface EngineSetup {
  /** How every engine and helper child in this window is started. */
  launch: EngineLaunch
  /** The ripgrep that launch points the engine at, for diagnostics. */
  ripgrep: RipgrepLocation
  /** Each conversation engine's memory limit, or null for none. */
  memoryLimit: MemoryLimit | null
}

export function setUpEngine(context: vscode.ExtensionContext): EngineSetup {
  const extensionRoot = context.extensionUri.fsPath
  const config = vscode.workspace.getConfiguration()
  const { launch, warning } = resolveEngineLaunch({
    extensionRoot,
    platform: process.platform,
    execPath: process.execPath,
    overridePath: config.get<string>(ENGINE_PATH_SETTING),
  })
  ensureEngineExecutable(launch)
  if (warning) void vscode.window.showWarningMessage(`Rayucode: ${warning}`)

  const ripgrep = resolveRipgrep({
    extensionRoot,
    appRoot: vscode.env.appRoot,
    platform: process.platform,
    arch: process.arch,
  })
  if (ripgrep.source === 'bundled' && ripgrep.path) ensureExecutableFile(ripgrep.path)

  const memoryLimit = resolveMemoryLimit({
    runtime: launch.runtime,
    settingMB: config.get<unknown>(MEMORY_LIMIT_SETTING),
    hostEnv: process.env,
  })

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration(ENGINE_PATH_SETTING) ||
        event.affectsConfiguration(MEMORY_LIMIT_SETTING)
      ) {
        void offerReload()
      }
    }),
  )
  const withRipgrep = ripgrep.path
    ? withLaunchEnv(launch, { RAYU_RIPGREP_PATH: ripgrep.path })
    : launch
  return { launch: { ...withRipgrep, memoryLimit }, ripgrep, memoryLimit }
}

async function offerReload(): Promise<void> {
  const RELOAD = 'Reload Window'
  const choice = await vscode.window.showInformationMessage(
    'Rayucode applies the new engine setting after the window reloads.',
    RELOAD,
  )
  if (choice === RELOAD) await vscode.commands.executeCommand('workbench.action.reloadWindow')
}
