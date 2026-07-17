import Link from 'next/link'
import Image from 'next/image'
import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import NavAuth from './components/NavAuth'
import { Providers } from './providers'
import { getOrganizationSchema, getWebsiteSchema } from './structured-data'

export const metadata: Metadata = {
  metadataBase: new URL('https://rayucode.com'),
  title: {
    default: 'Rayu - Terminal AI Coding Agent | Multi-Provider CLI Tool',
    template: '%s | Rayu',
  },
  description:
    'Rayu is a multi-provider terminal AI coding agent. Connect any LLM, use 600+ MCP tools, and ship faster with autonomous agents that write, test, and deploy your code.',
  keywords: [
    'AI coding agent',
    'terminal AI',
    'CLI coding tool',
    'multi-provider AI',
    'MCP servers',
    'AI developer tools',
    'autonomous coding',
    'terminal coding assistant',
  ],
  authors: [{ name: 'Rayu', url: 'https://rayucode.com' }],
  creator: 'Rayu',
  publisher: 'Rayu',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://rayucode.com',
    siteName: 'Rayu',
    title: 'Rayu - Terminal AI Coding Agent | Multi-Provider CLI Tool',
    description:
      'Rayu is a multi-provider terminal AI coding agent. Connect any LLM, use 600+ MCP tools, and ship faster with autonomous agents that write, test, and deploy your code.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Rayu - Terminal AI Coding Agent',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    site: '@rayucode',
    creator: '@rayucode',
    title: 'Rayu - Terminal AI Coding Agent | Multi-Provider CLI Tool',
    description:
      'Rayu is a multi-provider terminal AI coding agent. Connect any LLM, use 600+ MCP tools, and ship faster with autonomous agents.',
    images: ['/og-image.png'],
  },
  alternates: {
    canonical: 'https://rayucode.com',
  },
  verification: {
    google: 'google-site-verification-code', // Replace with actual code from Google Search Console
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const organizationJson = JSON.stringify(getOrganizationSchema())
  const websiteJson = JSON.stringify(getWebsiteSchema())

  return (
    <Providers>
      <html lang="en">
        <body>
          <Script
            id="schema-org-organization"
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: organizationJson }}
          />
          <Script
            id="schema-org-website"
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: websiteJson }}
          />
          <div className="site">
            <header className="nav">
              <Link href="/" className="nav-logo">
                <Image
                  src="/rayucode-logo.png"
                  alt="RAYU Code Logo"
                  width={32}
                  height={32}
                  className="nav-logo-mark"
                  priority
                />
                RAYU
              </Link>
              <ul className="nav-links" style={{ marginLeft: '2.5rem', marginRight: 'auto' }}>
                <li><Link href="/plans">Plans</Link></li>
                <li><Link href="/docs">Docs</Link></li>
                <li><Link href="/changelog">Changelog</Link></li>
              </ul>
              <div className="nav-actions">
                <NavAuth />
              </div>
            </header>
            {children}
          </div>
        </body>
      </html>
    </Providers>
  )
}
