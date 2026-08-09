'use client'

// RD-MEDIA-03 · Page header with the event in the breadcrumb.
//
// Renders the SAME `PageHeader` every other dashboard page uses — this is not a new header,
// it is the existing one with one extra crumb:
//
//   Media Studio ▸ Kochi Marathon ▸ Import Media
//
// A page cannot do this itself: the active event is client state, and the pages are server
// components. So the header becomes a thin client wrapper and the pages keep their own
// title and subtitle.

import { PageHeader } from '@/components/ui'
import { ROUTES } from '@/config/navigation'
import { useMediaStudio, withEvent } from '@/features/media-studio/context/MediaStudioContext'

export interface MediaStudioHeaderProps {
  title:    string
  subtitle: string
  /** The final crumb. Defaults to `title`. */
  crumb?:   string
}

export function MediaStudioHeader({ title, subtitle, crumb }: MediaStudioHeaderProps) {
  const { event } = useMediaStudio()

  const breadcrumb = [
    { label: 'Media Studio', href: ROUTES.MEDIA_STUDIO },
    // The event crumb links back to the hub FOR THIS EVENT, so following it keeps the
    // workspace rather than dropping the organizer back to "which event was I in?".
    ...(event ? [{ label: event.name, href: withEvent(ROUTES.MEDIA_STUDIO, event.eventId) }] : []),
    { label: crumb ?? title },
  ]

  return <PageHeader title={title} subtitle={subtitle} breadcrumb={breadcrumb} />
}
