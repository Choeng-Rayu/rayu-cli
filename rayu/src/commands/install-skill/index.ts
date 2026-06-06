import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'install-skill',
  description:
    'Install a skill into Rayu from a GitHub repo, a SKILL.md URL, or a local path',
  argumentHint: '<github owner/repo | url | path> [--overwrite]',
  load: () => import('./install-skill.js'),
} satisfies Command
