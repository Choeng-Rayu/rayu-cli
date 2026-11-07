/**
 * One engine-child action for a host command, with the error toast in one place.
 *
 * The frame loop itself lives in `host/settings/engineChildAction.ts`; this only ties it
 * to a command's context and reports a failure the way every command should.
 */
import * as vscode from 'vscode'

import type { EngineChildActionRequest, EngineChildActionOutcome } from '../settings/engineChildAction.js'
import { runEngineChildAction } from '../settings/engineChildAction.js'
import type { HostCommandContext } from './index.js'

export function runChildAction<T>(
  ctx: HostCommandContext,
  request: Omit<EngineChildActionRequest<T>, 'cwd'>,
): Promise<EngineChildActionOutcome<T>> {
  return runEngineChildAction<T>(ctx.launch, { cwd: ctx.cwd, ...request }).then(result => {
    if (!result.ok) void vscode.window.showErrorMessage(result.error)
    return result
  })
}
