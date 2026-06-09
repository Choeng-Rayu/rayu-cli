import type { LocalCommandResult } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'

const LINKEDIN_URL = 'https://www.linkedin.com/in/rayu-choeng-351243335/'
const GITHUB_URL = 'https://github.com/Choeng-Rayu'

export async function call(): Promise<LocalCommandResult> {
  // Open both developer profiles in the browser.
  const linkedinOk = await openBrowser(LINKEDIN_URL)
  const githubOk = await openBrowser(GITHUB_URL)

  if (linkedinOk && githubOk) {
    return {
      type: 'text',
      value: `Opening developer profiles in your browser:\n  LinkedIn: ${LINKEDIN_URL}\n  GitHub:   ${GITHUB_URL}`,
    }
  }

  return {
    type: 'text',
    value: `Failed to open the browser. Reach the developer here:\n  LinkedIn: ${LINKEDIN_URL}\n  GitHub:   ${GITHUB_URL}`,
  }
}
