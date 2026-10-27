// RD-WA-TEMPLATES-01 · Server wrapper so the route can export `metadata` (the queue is a client component).
import { Suspense } from 'react'
import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata('WhatsApp Templates', 'Review organizer WhatsApp templates, track Meta approval, and set the review mode.')

export default function Page() {
  return <Suspense><PageClient /></Suspense>
}
