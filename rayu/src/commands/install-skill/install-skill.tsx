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
  | { status: 'done'; skills: InstalledSkill[] }
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
        const skills = await installSkillFromSource(source, { overwrite })
        if (cancelled) return
        setState({ status: 'done', skills })
        const replaced = skills.filter(s => s.replaced).map(s => s.name)
        const fresh = skills.filter(s => !s.replaced).map(s => s.name)
        const parts: string[] = []
        if (fresh.length) parts.push(`installed ${fresh.join(', ')}`)
        if (replaced.length)
          parts.push(`overwrote already-installed ${replaced.join(', ')}`)
        onDone(`Skill install complete — ${parts.join('; ')}.`)
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

  const { skills } = state
  const replacedCount = skills.filter(s => s.replaced).length
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text color="green">
        Installed {skills.length} skill{skills.length === 1 ? '' : 's'}
        {replacedCount > 0
          ? ` (${replacedCount} already existed and ${replacedCount === 1 ? 'was' : 'were'} overwritten)`
          : ''}
        :
      </Text>
      {skills.map(s => (
        <Box key={s.name} flexDirection="column" marginTop={1}>
          <Text bold>
            /{s.name}
            {s.replaced ? <Text color="yellow"> (overwritten)</Text> : null}
          </Text>
          {s.description ? <Text dimColor>{s.description}</Text> : null}
          <Text dimColor>Location: {s.path}</Text>
        </Box>
      ))}
      <Text>
        {skills.length === 1
          ? `It is available now as /${skills[0]!.name} or via the Skill tool.`
          : 'They are available now via /<name> or the Skill tool.'}
      </Text>
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
