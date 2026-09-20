import { runAction, writeError } from './lib.mjs'

try {
  await runAction()
} catch (error) {
  writeError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
