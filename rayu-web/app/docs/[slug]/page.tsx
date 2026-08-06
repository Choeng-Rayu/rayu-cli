import React from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import DocsLayout from '../DocsLayout'
import DocsRenderer from '../DocsRenderer'
import { getDocs, getDocContent } from '../getDocs'

interface PageProps {
  params: Promise<{
    slug: string
  }>
}

export const dynamicParams = false

export async function generateStaticParams() {
  return getDocs().map((doc) => ({
    slug: doc.slug,
  }))
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const doc = getDocs().find((item) => item.slug === slug)

  if (!doc) {
    return {
      title: 'Document Not Found',
      robots: { index: false, follow: false },
    }
  }

  const url = `https://rayucode.com/docs/${encodeURIComponent(doc.slug)}`
  const description = `Read the ${doc.title} guide in the Rayu documentation.`

  return {
    title: doc.title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: `${doc.title} | Rayu Documentation`,
      description,
      url,
    },
  }
}

export default async function DocSlugPage({ params }: PageProps) {
  const { slug } = await params
  const docs = getDocs()

  if (!docs.some((doc) => doc.slug === slug)) {
    notFound()
  }

  return (
    <DocsLayout docs={docs} activeSlug={slug}>
      <DocsRenderer content={getDocContent(slug)} />
    </DocsLayout>
  )
}
