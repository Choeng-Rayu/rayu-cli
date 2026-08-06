import fs from 'fs'
import path from 'path'

export interface DocItem {
  slug: string     // e.g. "01-installation"
  filename: string // e.g. "01-installation.md"
  title: string    // e.g. "Installation"
}

export function getDocs(): DocItem[] {
  const docsDir = path.join(process.cwd(), 'public/docs')
  let filenames: string[] = []

  if (fs.existsSync(docsDir)) {
    filenames = fs.readdirSync(docsDir)
  } else {
    // Fallback during dev if the copy task hasn't run yet. Docs live at the repo
    // root (documentations/), which is also what scripts/copy-docs.js reads.
    const fallbackDir = path.join(process.cwd(), '../documentations')
    if (fs.existsSync(fallbackDir)) {
      filenames = fs.readdirSync(fallbackDir)
    }
  }

  return filenames
    .filter(file => file.endsWith('.md') && file !== 'README.md' && file !== 'CHANGELOG.md')
    .sort((a, b) => a.localeCompare(b))
    .map(file => {
      const slug = file.replace(/\.md$/, '')

      // Beautiful human-readable title extraction
      const title = slug
        .replace(/^\d+-/, '') // strip leading "01-", "12-", etc.
        .split('-')
        .map(word => {
          if (word.toUpperCase() === 'MCP') return 'MCP'
          if (word.toUpperCase() === 'CLI') return 'CLI'
          return word.charAt(0).toUpperCase() + word.slice(1)
        })
        .join(' ')

      return {
        slug,
        filename: file,
        title,
      }
    })
}

export function getDocContent(slug: string): string {
  const docsDir = path.join(process.cwd(), 'public/docs')
  const filePath = path.join(docsDir, `${slug}.md`)

  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8')
  }

  // Fallback to source dir
  const fallbackDir = path.join(process.cwd(), '../rayu/documentations')
  const fallbackPath = path.join(fallbackDir, `${slug}.md`)

  if (fs.existsSync(fallbackPath)) {
    return fs.readFileSync(fallbackPath, 'utf-8')
  }

  return '# Document Not Found\nThe requested documentation could not be loaded.'
}
