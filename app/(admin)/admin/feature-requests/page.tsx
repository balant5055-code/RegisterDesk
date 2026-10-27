// RD-FEATURE-REQ-01 · Server wrapper so the route can export `metadata` (the console is a client component).
import { Suspense } from 'react'
import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata('Feature Requests', 'Organizer feature requests — triage, responses, duplicates and rollout plans.')

export default function Page() {
  return <Suspense><PageClient /></Suspense>
}
