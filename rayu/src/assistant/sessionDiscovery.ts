// Stub: assistant session discovery absent from the leaked tree. The remote
// "assistant" (bridge) feature is infra-gated and disabled in Rayu.
export type AssistantSession = {
  sessionId: string
  title?: string
  [k: string]: unknown
}

export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  return []
}
