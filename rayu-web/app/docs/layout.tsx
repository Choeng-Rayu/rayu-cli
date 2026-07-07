import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'Rayu documentation. Learn how to connect LLMs, use MCP servers, and build with autonomous AI coding agents in your terminal.',
  openGraph: {
    title: 'Documentation | Rayu',
    description:
      'Rayu documentation. Learn how to connect LLMs, use MCP servers, and build with autonomous AI coding agents in your terminal.',
    url: 'https://rayucode.com/docs',
  },
  alternates: {
    canonical: 'https://rayucode.com/docs',
  },
}

export default function DocsLayoutWrapper({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
