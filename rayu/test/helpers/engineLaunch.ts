/**
 * Engine launches for tests that start a real or fake engine through the host code.
 *
 * Goes through the production constructors, so a test exercises the same command and
 * environment the extension uses. By default the "embedded" runtime is this test's own
 * (`process.execPath`, i.e. bun), exactly as the host used to be driven before the
 * launcher existed; pass `nodePath` to run under a specific Node instead.
 */
import {
  nativeEngineLaunch,
  scriptEngineLaunch,
  type EngineLaunch,
} from '../../src/vscode/host/engine/engineLaunch.js'

export function scriptLaunch(enginePath: string, nodePath?: string): EngineLaunch {
  return scriptEngineLaunch({ enginePath, nodePath, execPath: process.execPath })
}

export function nativeLaunch(binary: string): EngineLaunch {
  return nativeEngineLaunch(binary)
}
