export type Workflow = 'rayu' | 'rayu-review'

export type InstallGitHubAppStep =
  | 'configuration'
  | 'checking-github'
  | 'choose-repo'
  | 'install-app'
  | 'select-workflows'
  | 'credential'
  | 'api-key'
  | 'creating'
  | 'success'
  | 'error'

export type State = {
  step: InstallGitHubAppStep
  selectedRepoName: string
  selectedWorkflows: Workflow[]
  apiKey: string
  secretExists: boolean
  progress: string
  error?: string
  pullRequestUrl?: string
}
