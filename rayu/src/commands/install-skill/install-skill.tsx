// /install-skill — install a skill into Rayu from a GitHub repo, a SKILL.md
// URL, or a local path. Thin UI wrapper around installSkillFromSource.
import React, { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { Spinner } from '../../components/Spinner.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  installSkillFromSource,
  type InstalledSkill,
} from '../../skills/installSkill.js'

type State =
  | { status: 'installing' }
  | { status: 'done'; skill: InstalledSkill }
  | { status: 'error'; message: string }

function InstallSkillFlow({
  source,
  overwrite,
  onDone,
}: {
  source: string
  overwrite: boolean
  onDone: (result?: string) => void
}): React.ReactNode {
  const [state, setState] = useState<State>({ status: 'installing' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const skill = await installSkillFromSource(source, { overwrite })
        if (cancelled) return
        setState({ status: 'done', skill })
        onDone(`Installed skill "${skill.name}" → ${skill.path}`)
      } catch (e: unknown) {
        if (cancelled) return
        const message = e instanceof Error ? e.message : String(e)
        setState({ status: 'error', message })
        onDone(`Failed to install skill: ${message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source, overwrite, onDone])

  if (state.status === 'installing') {
    return (
      <Box flexDirection="row" gap={1} paddingLeft={1}>
        <Spinner />
        <Text>Installing skill from {source}…</Text>
      </Box>
    )
  }

  if (state.status === 'error') {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color="red">Could not install skill: {state.message}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color="green">Installed skill: </Text>
      <Text bold>
        /{state.skill.name}
      </Text>
      <Text dimColor>{state.skill.description}</Text>
      <Text dimColor>Location: {state.skill.path}</Text>
      <Text>It is available now as /{state.skill.name} or via the Skill tool.</Text>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const overwrite = tokens.includes('--overwrite')
  const source = tokens.filter(t => t !== '--overwrite').join(' ').trim()

  if (!source) {
    onDone(
      'Usage: /install-skill <github owner/repo | https://… | ./path> [--overwrite]',
    )
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">
          Provide a source: a GitHub repo (owner/repo[/subdir]), a SKILL.md URL,
          or a local path. Add --overwrite to replace an existing skill.
        </Text>
      </Box>
    )
  }

  return <InstallSkillFlow source={source} overwrite={overwrite} onDone={onDone} />
}
