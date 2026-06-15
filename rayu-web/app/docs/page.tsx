import React from 'react'
import DocsLayout from './DocsLayout'
import DocsRenderer from './DocsRenderer'
import { getDocs, getDocContent } from './getDocs'

export default function DocsPage() {
  const docs = getDocs()
  const defaultDoc = docs[0]
  const content = defaultDoc ? getDocContent(defaultDoc.slug) : '# No Docs Found'
  const activeSlug = defaultDoc ? defaultDoc.slug : ''

  return (
    <DocsLayout docs={docs} activeSlug={activeSlug}>
      <DocsRenderer content={content} />
    </DocsLayout>
  )
}
