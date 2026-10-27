// RD-SUPPORT-01 · Server wrapper so the route can export `metadata` (the desk is a client component).
import { Suspense } from 'react'
import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata('Support Desk', 'Organizer support tickets — replies, internal notes, assignment and status.')

export default function Page() {
  return <Suspense><PageClient /></Suspense>
}
