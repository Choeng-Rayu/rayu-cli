/**
 * What the main-area body shows.
 *
 * A pure decision, kept out of App so the precedence is testable without mounting a
 * webview: a panel always hosts a conversation, a signed-out sidebar must offer the
 * sign-in gate before anything else, and only a signed-in sidebar that actually hosts a
 * conversation can switch between its list and that conversation.
 */
export type SidebarBody = 'signin' | 'sessions' | 'chat'

export function sidebarBody(args: {
  surface: 'sidebar' | 'panel'
  signedOut: boolean
  hasConversation: boolean
  view: 'chat' | 'sessions'
}): SidebarBody {
  if (args.surface === 'panel') return 'chat'
  if (args.signedOut) return 'signin'
  if (!args.hasConversation) return 'sessions'
  return args.view === 'sessions' ? 'sessions' : 'chat'
}
