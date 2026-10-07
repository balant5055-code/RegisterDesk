// RD-CE-FIX (slug timing) · is the public URL this draft will publish under already another event's?
// SERVER-ONLY.
//
// Publish discovers a taken slug inside its transaction (SLUG_CONFLICT) — but by then a paid
// organizer has already been charged on License & Services. The same slug publish will mint
// (buildEventSlug, identical inputs) is checked here BEFORE any payment, so the organizer can pick
// another URL first. Publish keeps its own authoritative in-transaction check (a race is still safe).

import { adminDb } from '@/lib/firebase/admin'
import { buildEventSlug } from './slug'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** The slug when it is taken by a DIFFERENT draft's live event; null when free (or already this draft's). */
export async function eventSlugTakenByOther(draftId: string, eventDetails: unknown): Promise<string | null> {
  const details = (eventDetails && typeof eventDetails === 'object' ? eventDetails : {}) as Record<string, unknown>
  const seo  = (details.seo  as Record<string, unknown> | undefined) ?? {}
  const info = (details.info as Record<string, unknown> | undefined) ?? {}
  const slug = buildEventSlug({ customSlug: str(seo.urlSlug).trim(), eventName: str(info.name).trim(), draftId })
  if (!slug) return null
  const snap = await adminDb.collection('events').doc(slug).get()
  return snap.exists && snap.get('draftId') !== draftId ? slug : null
}
