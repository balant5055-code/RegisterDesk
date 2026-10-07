// ─── The public gate for /events/[slug] and everything under it ──────────────
//
// This layout renders nothing. It exists to decide, ONCE and ABOVE the streaming boundary,
// whether the public may see this event at all.
//
// ═══ WHY A LAYOUT AND NOT THE PAGE ═══════════════════════════════════════════
// `loading.tsx` in this segment wraps the segment's CHILDREN in Suspense. Next flushes the
// shell — HTTP 200 headers plus the skeleton — as soon as it hits that boundary, so a
// notFound() thrown inside the page body can only swap the UI inside a stream whose status
// line was sent long before. That is why an unknown slug used to answer 200 with
// "Event not found" in the body, while /results and /tickets — which have no ancestor
// loading.tsx — returned a correct 404 from the identical call.
//
// generateMetadata was tried first and measured: on Next 16.2.7 it is ALSO streamed, so
// throwing there still produced 200. A layout body, by contrast, runs before its children
// are wrapped in Suspense, so notFound() here sets a real 404 status.
//
// The loading skeletons were deliberately NOT deleted to fix the status. They do real work
// on a slow event page, and they still run for every event that exists.
//
// ═══ WHY THIS COVERS FIVE ROUTES ═════════════════════════════════════════════
// A layout applies to its segment and every nested segment, so this one file gates
// /events/[slug] and its certificates, gallery, photos and register children. Before it,
// each of those answered the "may the public see this?" question separately, and three
// answered it wrongly — /photos and /register checked only that the document existed, and
// /certificates read the event doc inline and published its NAME for a draft or taken-down
// event. One gate above them all is what makes those divergences impossible rather than
// merely fixed.
//
// ═══ COST ════════════════════════════════════════════════════════════════════
// getEventBySlug is React.cache()-wrapped, so this lookup and the page's own read collapse
// into ONE Firestore read per request.

import type { ReactNode } from 'react'
import { requirePublicEvent } from '@/lib/events/publicEventAccess'

export default async function EventSlugLayout({
  children, params,
}: {
  children: ReactNode
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  // Throws notFound() — a real 404 — for a missing, non-public or taken-down event.
  // Invite-only (`visibility: 'private'`) events deliberately pass: they are unlisted and
  // noindexed, not inaccessible, because their invitees reach them by link.
  await requirePublicEvent(slug)

  // No wrapper element: the shells below (EventPageShell, EventUtilityLayout) own the
  // chrome, and adding a node here would change their layout.
  return <>{children}</>
}
