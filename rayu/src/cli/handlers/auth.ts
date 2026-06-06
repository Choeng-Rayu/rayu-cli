/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAnthropicApiKeyWithSource,
  isUsing3PServices,
} from '../../utils/auth.js'
import { getAPIProvider } from '../../utils/model/providers.js'

export async function installOAuthTokens(): Promise<void> {
  throw new Error(
    'OAuth login is not supported in Rayu. Configure providers with /connect or ~/.rayu/providers.json.',
  )
}

export async function authLogin(): Promise<void> {
  process.stderr.write(
    'OAuth login is not supported in Rayu. Use /connect or edit ~/.rayu/providers.json.\n',
  )
  process.exit(1)
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const loggedIn = apiKeySource !== 'none' || isUsing3PServices()
  const apiProvider = getAPIProvider()

  if (opts.text) {
    if (loggedIn) {
      process.stdout.write(`Provider: ${apiProvider}\n`)
      if (apiKeySource !== 'none') {
        process.stdout.write(`API key: ${apiKeySource}\n`)
      }
    } else {
      process.stdout.write(
        'No Rayu provider is configured. Use /connect or edit ~/.rayu/providers.json.\n',
      )
    }
  } else {
    process.stdout.write(
      jsonStringify(
        {
          loggedIn,
          authMethod: loggedIn ? 'rayu_provider' : 'none',
          apiProvider,
          apiKeySource: apiKeySource === 'none' ? null : apiKeySource,
        },
        null,
        2,
      ) + '\n',
    )
  }

  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  process.stdout.write('Rayu provider credentials are managed in ~/.rayu/providers.json.\n')
  process.exit(0)
}
