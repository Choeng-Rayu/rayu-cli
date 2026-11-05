/**
 * `/permissions` — list the stored permission rules, add one, or remove one.
 *
 * The rules are read, parsed and written in the settings child. Editing settings files
 * is picked up live by a running engine (headless mode subscribes to settings changes),
 * so a saved rule takes effect without restarting the conversation.
 */
import * as vscode from 'vscode'

import type {
  EditablePermissionSource,
  PermissionRuleBehavior,
  PermissionRuleView,
  PermissionsFrame,
} from '../../shared/settingsChildProtocol.js'
import { runChildAction } from './childAction.js'
import type { HostCommandContext } from './index.js'

const BEHAVIORS: ReadonlyArray<{ behavior: PermissionRuleBehavior; label: string; description: string }> = [
  { behavior: 'allow', label: 'Allow', description: 'Run without asking' },
  { behavior: 'deny', label: 'Deny', description: 'Never run' },
  { behavior: 'ask', label: 'Ask', description: 'Ask before running' },
]

const SOURCES: ReadonlyArray<{ scope: EditablePermissionSource; label: string; description: string }> = [
  { scope: 'user', label: 'User settings', description: '~/.rayu/settings.json — every project' },
  { scope: 'project', label: 'Project settings', description: '.rayu/settings.json — shared with the repository' },
  { scope: 'local', label: 'Local settings', description: '.rayu/settings.local.json — this checkout only' },
]

interface RulePick extends vscode.QuickPickItem {
  rule?: PermissionRuleView
}

interface BehaviorPick extends vscode.QuickPickItem {
  behavior: PermissionRuleBehavior
}

interface SourcePick extends vscode.QuickPickItem {
  scope: EditablePermissionSource
}

export async function runPermissionsCommand(ctx: HostCommandContext): Promise<void> {
  let rules = await readRules(ctx)
  if (!rules) return
  while (true) {
    const pick = await vscode.window.showQuickPick<RulePick>(buildItems(rules), {
      placeHolder: 'Permission rules — choose a rule to remove, or add one',
      matchOnDescription: true,
    })
    if (!pick) return
    if (!pick.rule) {
      if (await addRule(ctx)) rules = (await readRules(ctx)) ?? rules
      continue
    }
    const rule = pick.rule
    const answer = await vscode.window.showWarningMessage(
      `Remove the ${rule.behavior} rule "${rule.rule}" from ${sourceLabel(rule.source)}?`,
      { modal: true },
      'Remove',
    )
    if (answer !== 'Remove') continue
    const result = await runChildAction<never>(ctx, {
      action: {
        action: 'permission-remove',
        behavior: rule.behavior,
        rule: rule.rule,
        source: rule.source,
      },
      fallbackError: 'Removing the permission rule returned no answer.',
    })
    if (!result.ok) return
    rules = (await readRules(ctx)) ?? rules.filter(candidate => candidate.rule !== rule.rule || candidate.source !== rule.source)
  }
}

async function readRules(ctx: HostCommandContext): Promise<PermissionRuleView[] | undefined> {
  const result = await runChildAction<PermissionRuleView[]>(ctx, {
    action: { action: 'permissions-read' },
    consumeFrame: frame =>
      frame.type === 'rayucode_permissions'
        ? (frame as unknown as PermissionsFrame).rules
        : undefined,
    fallbackError: 'Reading the permission rules returned nothing.',
  })
  return result.ok ? result.value : undefined
}

function buildItems(rules: readonly PermissionRuleView[]): RulePick[] {
  const items: RulePick[] = [{ label: '$(add) Add permission rule…' }]
  for (const { behavior, label } of BEHAVIORS) {
    const group = rules.filter(rule => rule.behavior === behavior)
    if (group.length === 0) continue
    items.push({ label, kind: vscode.QuickPickItemKind.Separator })
    for (const rule of group) {
      items.push({ label: rule.rule, description: sourceLabel(rule.source), rule })
    }
  }
  return items
}

async function addRule(ctx: HostCommandContext): Promise<boolean> {
  const behavior = await vscode.window.showQuickPick<BehaviorPick>(
    BEHAVIORS.map(({ behavior, label, description }) => ({ label, description, behavior })),
    { placeHolder: 'What should this rule do?' },
  )
  if (!behavior) return false

  const source = await vscode.window.showQuickPick<SourcePick>(
    SOURCES.map(({ scope, label, description }) => ({ label, description, scope })),
    { placeHolder: 'Where should the rule be saved?' },
  )
  if (!source) return false

  const rule = await vscode.window.showInputBox({
    prompt: 'Permission rule',
    placeHolder: 'Bash(npm test), Read(src/**) or WebFetch',
    validateInput: value =>
      value.trim() ? undefined : 'Enter a tool name, for example Bash or Read.',
  })
  if (rule === undefined) return false

  const result = await runChildAction<never>(ctx, {
    action: {
      action: 'permission-add',
      behavior: behavior.behavior,
      rule,
      source: source.scope,
    },
    fallbackError: 'Saving the permission rule returned no answer.',
  })
  if (!result.ok) return false
  void vscode.window.showInformationMessage(
    `Added ${behavior.behavior} rule "${rule.trim()}" to ${sourceLabel(source.scope)}.`,
  )
  return true
}

function sourceLabel(source: EditablePermissionSource): string {
  return SOURCES.find(entry => entry.scope === source)?.label ?? source
}
