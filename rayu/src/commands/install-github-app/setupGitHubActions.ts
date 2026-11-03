import { saveGlobalConfig } from '../../utils/config.js'
import { openBrowser } from '../../utils/browser.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logError } from '../../utils/log.js'
import type { RayuGitHubIntegrationConfig } from '../../constants/github-app.js'
import type { Workflow } from './types.js'
import {
  setupGitHubActionsCore,
  type SetupGitHubActionsResult,
} from './setupGitHubActionsCore.js'

export type SetupGitHubActionsOptions = {
  repoName: string
  apiKey: string | null
  secretName: string
  selectedWorkflows: Workflow[]
  config: RayuGitHubIntegrationConfig
  updateProgress?: (message: string) => void
  openUrl?: (url: string) => Promise<void>
}

export type { SetupGitHubActionsResult }

/** Terminal adapter around the host-neutral GitHub setup implementation. */
export async function setupGitHubActions({
  openUrl,
  ...options
}: SetupGitHubActionsOptions): Promise<SetupGitHubActionsResult> {
  try {
    const result = await setupGitHubActionsCore({
      ...options,
      runGitHubCommand: async (args, input) => {
        const response = await execFileNoThrow('gh', args, {
          ...(input === undefined ? {} : { stdin: 'pipe' as const, input }),
        })
        return response
      },
    })
    options.updateProgress?.('Opening the pull-request form')
    if (openUrl) await openUrl(result.pullRequestUrl)
    else await openBrowser(result.pullRequestUrl)

    saveGlobalConfig(current => ({
      ...current,
      githubActionSetupCount: (current.githubActionSetupCount ?? 0) + 1,
    }))
    return result
  } catch (error) {
    if (error instanceof Error) logError(error)
    throw error
  }
}
