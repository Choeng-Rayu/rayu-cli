import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'See the latest updates and releases for Rayu CLI. New features, bug fixes, and improvements to the autonomous AI coding agent.',
  openGraph: {
    title: 'Changelog | Rayu',
    description:
      'See the latest updates and releases for Rayu CLI. New features, bug fixes, and improvements to the autonomous AI coding agent.',
    url: 'https://rayucode.com/changelog',
  },
  alternates: {
    canonical: 'https://rayucode.com/changelog',
  },
}

export default function ChangelogLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
