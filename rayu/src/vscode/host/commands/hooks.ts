/**
 * `/hooks` — every hook configured in Rayu's settings files, as a read-only Markdown tab.
 *
 * The child calls `getAllHooks()` without a session app state, so this deliberately lists
 * settings-file hooks only; session, plugin and built-in hooks belong to a running
 * conversation and are called out as absent rather than silently looked for.
 */
import type { HookView, HooksFrame } from '../../shared/settingsChildProtocol.js'
import { runChildAction } from './childAction.js'
import type { HostCommandContext } from './index.js'
import { showMarkdownDocument } from './openMarkdown.js'

export async function runHooksCommand(ctx: HostCommandContext): Promise<void> {
  const result = await runChildAction<HookView[]>(ctx, {
    action: { action: 'hooks-read' },
    consumeFrame: frame =>
      frame.type === 'rayucode_hooks' ? (frame as unknown as HooksFrame).hooks : undefined,
    fallbackError: 'Reading the hooks returned nothing.',
  })
  if (!result.ok || !result.value) return
  await showMarkdownDocument(hooksMarkdown(result.value))
}

export function hooksMarkdown(hooks: readonly HookView[]): string {
  const lines = [
    '# Hooks',
    '',
    '_This lists hooks from Rayu settings files only. Session, plugin and built-in hooks are not shown here._',
    '',
  ]
  if (hooks.length === 0) {
    lines.push('No hooks are configured in the settings files.')
    return `${lines.join('\n').trim()}\n`
  }

  const byEvent = new Map<string, HookView[]>()
  for (const hook of hooks) {
    const group = byEvent.get(hook.event)
    if (group) group.push(hook)
    else byEvent.set(hook.event, [hook])
  }

  for (const [event, group] of byEvent) {
    lines.push(`## ${event}`, '')
    for (const hook of group) {
      const matcher = hook.matcher ? ` · \`${hook.matcher}\`` : ''
      lines.push(`- **${sourceLabel(hook.source)}**${matcher} — \`${oneLine(hook.text)}\` (${hook.kind})`)
    }
    lines.push('')
  }

  return `${lines.join('\n').trim()}\n`
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'userSettings':
      return 'User settings'
    case 'projectSettings':
      return 'Project settings'
    case 'localSettings':
      return 'Local settings'
    default:
      return source
  }
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/`/g, '\\`')
}
