// Mirror the bundled rayu skills into a standalone repo tree for
// https://github.com/Rayu-Code/skills.git.
//
// Single source of truth: src/skills/bundled/rayu/<name>/SKILL.md (+ reference
// files). This script copies them into a clean publishable tree and adds the
// repo's README, MIT LICENSE, and a SKILL template. It does NOT push — review
// the output, then push manually (see README at the end of the run).
//
// Usage:
//   bun run scripts/sync-rayu-skills.ts [destDir]   (default: ./rayu-skills-dist)
import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join, resolve } from 'path'

const SRC = resolve('src/skills/bundled/rayu')
const DEST = resolve(process.argv[2] ?? 'rayu-skills-dist')

const YEAR = new Date().getFullYear()

const MIT_LICENSE = `MIT License

Copyright (c) ${YEAR} Rayu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

const TEMPLATE = `---
name: my-skill-name
description: A clear description of what this skill does and when an agent should use it.
---

# My Skill

Instructions the agent follows when this skill is active.

## Guidelines
- Keep it concrete and actionable.
`

function buildReadme(names: string[]): string {
  const list = names.map(n => `- \`${n}\``).join('\n')
  return `# Rayu Skills

Original, MIT-licensed [Agent Skills](https://agentskills.io) authored for
[Rayu CLI](https://github.com/Choeng-Rayu/rayu-cli). These ship **bundled** with
Rayu (available with no install) and are also installable into any
Agent-Skills-compatible tool.

Each skill is a folder under \`skills/<name>/\` with a \`SKILL.md\` (YAML
frontmatter: \`name\`, \`description\`) plus any reference files.

## Skills
${list}

## Install a single skill into Rayu
\`\`\`
/install-skill Rayu-Code/skills/skills/<name>
\`\`\`

## License
MIT — see [LICENSE](./LICENSE). All content is original.
`
}

function main(): void {
  const names = readdirSync(SRC)
    .filter(n => statSync(join(SRC, n)).isDirectory())
    .sort()

  const skillsDest = join(DEST, 'skills')
  rmSync(skillsDest, { recursive: true, force: true })
  mkdirSync(skillsDest, { recursive: true })
  for (const name of names) {
    cpSync(join(SRC, name), join(skillsDest, name), { recursive: true })
  }

  mkdirSync(join(DEST, 'template'), { recursive: true })
  writeFileSync(join(DEST, 'template', 'SKILL.md'), TEMPLATE)
  writeFileSync(join(DEST, 'LICENSE'), MIT_LICENSE)
  writeFileSync(join(DEST, 'README.md'), buildReadme(names))

  console.log(`Synced ${names.length} skills → ${DEST}`)
  console.log(`  ${names.join(', ')}`)
  console.log('\nTo publish (after review):')
  console.log(`  cd ${DEST} && git init -b main && git add . \\`)
  console.log('    && git commit -m "rayu skills" \\')
  console.log(
    '    && git remote add origin https://github.com/Rayu-Code/skills.git \\',
  )
  console.log('    && git push -u origin main')
}

main()
