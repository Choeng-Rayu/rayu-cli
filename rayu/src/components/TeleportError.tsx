import React, { useCallback, useEffect, useState } from 'react'
import { checkIsGitClean } from 'src/utils/background/remote/preconditions.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { TeleportStash } from './TeleportStash.js'

export type TeleportLocalErrorType = 'needsGitStash'

type TeleportErrorProps = {
  onComplete: () => void
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>
}

const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set()

export function TeleportError({
  onComplete,
  errorsToIgnore = EMPTY_ERRORS_TO_IGNORE,
}: TeleportErrorProps): React.ReactNode {
  const [currentError, setCurrentError] =
    useState<TeleportLocalErrorType | null>(null)

  const checkErrors = useCallback(async () => {
    const currentErrors = await getTeleportErrors()
    const filteredErrors = new Set(
      Array.from(currentErrors).filter(error => !errorsToIgnore.has(error)),
    )

    if (filteredErrors.size === 0) {
      onComplete()
      return
    }

    setCurrentError(filteredErrors.has('needsGitStash') ? 'needsGitStash' : null)
  }, [errorsToIgnore, onComplete])

  useEffect(() => {
    void checkErrors()
  }, [checkErrors])

  if (currentError !== 'needsGitStash') {
    return null
  }

  return (
    <TeleportStash
      onStashAndContinue={() => {
        void checkErrors()
      }}
      onCancel={() => gracefulShutdownSync(0)}
    />
  )
}

export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>()
  if (!(await checkIsGitClean())) {
    errors.add('needsGitStash')
  }
  return errors
}
