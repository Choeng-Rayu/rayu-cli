import type { SessionCallbacks } from '../../src/vscode/host/panel/sessionHandle.js'

export function sessionCallbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onEntry() {}, onPartial() {}, onComplete() {}, onTurnState() {},
    onModelInfo() {}, onError() {}, onPermissionRequest() {},
    onPermissionCancelled() {}, onSessionEnded() {}, onReviewCleared() {},
    onReviewFiles() {}, onInferenceSettings() {}, ...overrides,
  }
}

export async function until(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for session state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
