/**
 * `/doctor` — the engine's installation and configuration diagnostic, rendered as a
 * read-only Markdown tab.
 *
 * The report is produced by `src/utils/doctorDiagnostic.ts` in the settings child; the
 * host only formats the JSON it sends back.
 */
import type { DoctorFrame, DoctorReport } from '../../shared/settingsChildProtocol.js'
import { runChildAction } from './childAction.js'
import type { HostCommandContext } from './index.js'
import { showMarkdownDocument } from './openMarkdown.js'

export async function runDoctorCommand(ctx: HostCommandContext): Promise<void> {
  const result = await runChildAction<DoctorReport>(ctx, {
    action: { action: 'doctor' },
    consumeFrame: frame =>
      frame.type === 'rayucode_doctor'
        ? (frame as unknown as DoctorFrame).diagnostic
        : undefined,
    fallbackError: 'The doctor report returned nothing.',
  })
  if (!result.ok || !result.value) return
  await showMarkdownDocument(doctorMarkdown(result.value))
}

export function doctorMarkdown(diagnostic: DoctorReport): string {
  const permissions =
    diagnostic.hasUpdatePermissions === null
      ? 'unknown'
      : diagnostic.hasUpdatePermissions
        ? 'yes'
        : 'no'
  const lines = [
    '# Rayucode doctor',
    '',
    `- **Version**: ${diagnostic.version}`,
    `- **Installation**: ${diagnostic.installationType}`,
    `- **Install path**: ${diagnostic.installationPath}`,
    `- **Invoked binary**: ${diagnostic.invokedBinary}`,
    `- **Config install method**: ${diagnostic.configInstallMethod}`,
    `- **Auto-updates**: ${diagnostic.autoUpdates}`,
    `- **Update permissions**: ${permissions}`,
    `- **Ripgrep**: ${diagnostic.ripgrepStatus.working ? 'working' : 'not working'} (${diagnostic.ripgrepStatus.mode})`,
  ]
  if (diagnostic.packageManager) {
    lines.push(`- **Package manager**: ${diagnostic.packageManager}`)
  }

  lines.push('', '## Installations found', '')
  if (diagnostic.multipleInstallations.length === 0) {
    lines.push('No duplicate installations found.')
  } else {
    for (const installation of diagnostic.multipleInstallations) {
      lines.push(`- **${installation.type}**: ${installation.path}`)
    }
  }

  lines.push('', '## Warnings', '')
  if (diagnostic.warnings.length === 0) {
    lines.push('No problems detected.')
  } else {
    for (const warning of diagnostic.warnings) {
      lines.push(`### ${warning.issue}`, '', warning.fix, '')
    }
  }

  if (diagnostic.recommendation) {
    lines.push('## Recommendation', '', diagnostic.recommendation, '')
  }

  return `${lines.join('\n').trim()}\n`
}
