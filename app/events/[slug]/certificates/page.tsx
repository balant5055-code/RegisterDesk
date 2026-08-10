// /events/[slug]/certificates — the Event Day Certificate Center.
//
// This is the destination behind the venue QR poster. The QR carries ONLY the event slug:
// no participant name, email, registration id, certificate id or token. Identity is
// established here, by the attendee, and every lookup is scoped to this slug server-side.
//
// Server component: it resolves the event name for the header and hands off to the client
// island. No certificate data is fetched here — that only happens after the attendee
// identifies themselves through the rate-limited lookup API.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { adminDb } from '@/lib/firebase/admin'
import { MarketingPageLayout } from '@/components/marketing/layout/MarketingPageLayout'
import { CertificateCenterClient } from './CertificateCenterClient'

type Params = { params: Promise<{ slug: string }> }

/** Event name for the page header, or null when the slug is not a published event. */
async function getEventName(slug: string): Promise<string | null> {
  try {
    const snap = await adminDb.collection('events').doc(slug).get()
    if (!snap.exists) return null
    const d    = snap.data() as Record<string, unknown>
    const ed   = (d.eventDetails as Record<string, unknown> | undefined) ?? {}
    const info = (ed.info as Record<string, unknown> | undefined) ?? {}
    const name = typeof info.name === 'string' ? info.name.trim() : ''
    return name || slug
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params
  const name = await getEventName(slug)
  return {
    title:       name ? `Certificate Center — ${name}` : 'Certificate Center',
    description: 'Download your participation certificate.',
    // Lookup is a per-attendee action; there is nothing here worth indexing, and the page
    // exists to be reached by QR rather than by search.
    robots: { index: false, follow: false },
  }
}

export default async function CertificateCenterPage({ params }: Params) {
  const { slug } = await params
  const eventName = await getEventName(slug)
  // An unknown slug 404s rather than rendering a lookup form that could never match —
  // and without confirming anything about which slugs exist beyond a standard 404.
  if (!eventName) notFound()

  return (
    <MarketingPageLayout>
      <div className="min-h-[60vh] bg-[#f7f8fa]">
        <CertificateCenterClient slug={slug} eventName={eventName} />
      </div>
    </MarketingPageLayout>
  )
}
