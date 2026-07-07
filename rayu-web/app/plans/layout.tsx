import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Plans & Pricing',
  description:
    'Choose the perfect Rayu plan. From free BYOK to hosted enterprise tiers with credits for autonomous AI coding agents.',
  openGraph: {
    title: 'Plans & Pricing | Rayu',
    description:
      'Choose the perfect Rayu plan. From free BYOK to hosted enterprise tiers with credits for autonomous AI coding agents.',
    url: 'https://rayucode.com/plans',
  },
  alternates: {
    canonical: 'https://rayucode.com/plans',
  },
}

export default function PlansLayout({ children }: { children: React.ReactNode }) {
  return children
}
