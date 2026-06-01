// Stub: assistant install wizard absent from the leaked tree. The remote
// assistant install flow is infra-gated and disabled in Rayu.
export function NewInstallWizard(_props: {
  defaultDir: string
  onInstalled: (dir: string) => void
  onCancel: () => void
  onError: (message: string) => void
}): null {
  return null
}

export async function computeDefaultInstallDir(): Promise<string> {
  return process.cwd()
}
