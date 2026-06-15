import React from 'react'
import DocsLayout from '../DocsLayout'
import DocsRenderer from '../DocsRenderer'
import { getDocs, getDocContent } from '../getDocs'

interface PageProps {
  params: Promise<{
    slug: string
  }>
}

export async function generateStaticParams() {
  const docs = getDocs()
  return docs.map((doc) => ({
    slug: doc.slug,
  }))
}

export default async function DocSlugPage({ params }: PageProps) {
  const { slug } = await params
  const docs = getDocs()
  const content = getDocContent(slug)

  return (
    <DocsLayout docs={docs} activeSlug={slug}>
      <DocsRenderer content={content} />
    </DocsLayout>
  )
}
