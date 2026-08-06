import { MetadataRoute } from 'next'
import { getDocs } from './docs/getDocs'

const BASE_URL = 'https://rayucode.com'

/**
 * Only publicly accessible, canonical pages belong in this sitemap. Account,
 * billing, dashboard, admin, and API routes are intentionally excluded.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  const publicPages: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${BASE_URL}/plans`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/sign-in`,
      lastModified,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    {
      url: `${BASE_URL}/docs`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/changelog`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ]

  const documentationPages: MetadataRoute.Sitemap = getDocs().map((doc) => ({
    url: `${BASE_URL}/docs/${encodeURIComponent(doc.slug)}`,
    lastModified,
    changeFrequency: 'monthly',
    priority: 0.7,
  }))

  return [...publicPages, ...documentationPages]
}
