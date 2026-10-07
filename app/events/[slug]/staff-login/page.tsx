// /events/[slug]/staff-login — RD-TEAM-IMPL-01
//
// The staff sign-in an organizer actually hands out: one link per event, so a gate
// operator opens the page for the event they are working instead of being asked
// which of several it is.
//
// ═══ THE SLUG IS ROUTING, NEVER AUTHORIZATION ════════════════════════════════
// This server component resolves the slug to an event only so the page can SAY which
// event it belongs to and so the client knows where to go afterwards. It grants
// nothing. The order that matters is:
//
//     authenticate  →  server resolves the identity  →  server checks assignment
//
// and never `slug → trust → admit`. Two independent things enforce that:
//   • the client sends the resolved eventId to /api/checkin/ops/[eventId], which
//     re-runs authorizeEvent and answers 403 for an unassigned operator;
//   • the assignment list the client compares against comes from GET /api/staff/me,
//     which re-verifies the ID token server-side — not from this page.
//
// So a staff member who opens ANOTHER event's link can sign in (authentication is
// global, as it always was) and is then told they are not assigned to it. They are
// never shown that event's data, and the page reveals nothing a visitor could not
// already read: `events/{slug}` is the public event document.

import { notFound }       from 'next/navigation'
import type { Metadata }  from 'next'
import { ToastProvider }  from '@/components/ui/Toast'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { getEventCheckInStatus } from '@/lib/checkin/eventStatus'
import StaffLoginClient   from '@/app/staff/login/StaffLoginClient'

export const dynamic = 'force-dynamic'

// A credential prompt has nothing to index, and an event's staff door should not
// surface in search results next to its public page.
export const metadata: Metadata = {
  title:  'Staff sign-in',
  robots: { index: false, follow: false },
}

export default async function EventStaffLoginPage(
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const event = await getEventBySlug(slug)
  if (!event) notFound()

  const name = ((event.eventDetails?.info as Record<string, unknown> | undefined)?.name as string | undefined)
    ?? 'this event'

  // The SAME resolver every check-in route uses, so a cancelled, archived or
  // moderated event cannot present a working gate door.
  const accepting = (await getEventCheckInStatus(slug)) === 'ok'

  return (
    <ToastProvider>
      <StaffLoginClient event={{ slug, eventId: event.draftId, name, accepting }} />
    </ToastProvider>
  )
}
