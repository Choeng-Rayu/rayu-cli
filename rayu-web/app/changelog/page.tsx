import React from 'react'
import fs from 'fs'
import path from 'path'
import DocsRenderer from '../docs/DocsRenderer'

export default function ChangelogPage() {
  let content = ''
  const docsDir = path.join(process.cwd(), 'public/docs')
  const filePath = path.join(docsDir, 'CHANGELOG.md')

  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8')
  } else {
    // Fallback to source dir if build pre-step hasn't run yet
    const srcChangelog = path.join(process.cwd(), '../rayu/CHANGELOG.md')
    if (fs.existsSync(srcChangelog)) {
      content = fs.readFileSync(srcChangelog, 'utf-8')
    } else {
      content = '# Changelog Not Found\nThe changelog file could not be loaded.'
    }
  }

  return (
    <div className="container" style={{ maxWidth: '960px', padding: '4rem 2.5rem' }}>
      <div style={{ position: 'relative', zIndex: 10 }}>
        <DocsRenderer content={content} />
      </div>
    </div>
  )
}
