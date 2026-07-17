// Phase P.3 — /solutions/conferences route. Server Component (config only).

import type { Metadata } from 'next'
import { SolutionPage } from '@/components/marketing/solutions/SolutionPage'
import { buildMetadata } from '@/lib/marketing/seo'
import { SOLUTION_PAGES } from '@/content/marketing/solution-pages'

const CONFIG = SOLUTION_PAGES.conferences

export const metadata: Metadata = buildMetadata({ title: CONFIG.seo.title, description: CONFIG.seo.description, path: `/solutions/${CONFIG.slug}` })

export default function ConferencesSolutionPage() {
  return <SolutionPage config={CONFIG} />
}
