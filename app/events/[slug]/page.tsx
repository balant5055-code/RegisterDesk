import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { findPublicEvent }          from '@/lib/events/publicEventAccess'
import ReportButton                  from '@/components/report/ReportButton'
import type { EventDetailsDraft } from '@/components/wizard/eventDetailsConfig'
import { loadEventPageData, buildEventPageProps, publicOnlineVenue, eventImageUrls } from '@/lib/events/eventPageProps'
import { TemplateRouter } from '@/components/event-templates/TemplateRouter'
import { stripMarkdown } from '@/components/event-templates/shared/ui/RichText'
import type { PassPublic } from '@/components/event-templates/types'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { EventResultsBanner } from '@/features/race-operations/components/public/EventResultsBanner'

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 60

// ─── generateMetadata ─────────────────────────────────────────────────────────

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  // Runtime-editable platform identity (this route is already dynamic/ISR).
  const { platformName, baseUrl } = await getBrandingConfig()
  // layout.tsx has already 404'd anything the public may not see, so by the time this runs
  // the event exists and is viewable. The guard stays as a type narrowing and a fallback
  // title — it does NOT own the status. Throwing notFound() here would be misleading:
  // measured on Next 16.2.7, generateMetadata is itself streamed, so a throw at this point
  // cannot change a status that has already been sent. The 404 lives in the layout, above
  // the Suspense boundary, and nowhere else.
  //
  // findPublicEvent wraps getEventBySlug, which is React.cache()-wrapped: the layout read,
  // this one and the page body's collapse into ONE Firestore read per request.
  const event = await findPublicEvent(slug)
  if (!event) return { title: `Event Not Found – ${platformName}` }

  const ed       = event.eventDetails as unknown as EventDetailsDraft
  const title    = ed.seo?.metaTitle?.trim()       || ed.info?.name?.trim()      || 'Event'
  const desc     = ed.seo?.metaDescription?.trim() || ed.info?.shortDesc?.trim() || ''
  // RD-CUSTOM-PUBLIC-01 — the organizer's "Social Share Image" (SEO tab) was saved but never
  // used: link previews always took the cover banner. It now wins when it is a web URL.
  const share    = ed.seo?.shareImageUrl?.trim() || ''
  const { bannerUrl, logoUrl } = eventImageUrls(ed)
  const image    = (/^https?:\/\//i.test(share) ? share : '') || bannerUrl || logoUrl || ''
  const keywords = (ed.seo?.keywords ?? []).join(', ')
  const url      = `${baseUrl}/events/${slug}`

  return {
    title:       `${title} – ${platformName}`,
    description: desc,
    keywords:    keywords || undefined,
    metadataBase: new URL(baseUrl),
    alternates:  { canonical: url },
    // RD-SEO-01 — a PRIVATE event stays reachable by its link (invite-only access is the
    // product), but it must not be indexed. The sitemap already withholds it; this closes
    // the other path in, where a crawler follows a link someone shared publicly.
    robots: event.visibility === 'private' ? { index: false, follow: false } : undefined,
    openGraph: {
      type:        'website',
      url,
      title,
      description: desc,
      images:      image ? [{ url: image, width: 1200, height: 630, alt: title }] : [],
      siteName:    platformName,
    },
    twitter: {
      card:        'summary_large_image',
      title,
      description: desc,
      images:      image ? [image] : [],
    },
  }
}

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

function buildJsonLd(
  slug:   string,
  ed:     EventDetailsDraft,
  passes: PassPublic[],
): Record<string, unknown> {
  const venueType = ed.venue?.type ?? 'physical'
  const physical  = ed.venue?.physical
  // The public projection: never a "reveal after registration" link (RD-CUSTOM-PUBLIC-01).
  const online    = publicOnlineVenue(ed.venue?.online)
  // RD-CUSTOM-ORG-01 — the structured data follows the "Show organizer info" toggle, exactly as
  // the page does; it used to print the organizer's name and email even when the organizer hid them.
  const organizer = ed.publicPage?.showOrganizerInfo === false ? undefined : ed.organizer

  const location: Record<string, unknown> =
    venueType === 'online'
      ? { '@type': 'VirtualLocation', url: online?.meetingUrl?.trim() || `${BASE_URL}/events/${slug}` }
      : {
          '@type': 'Place',
          name:    physical?.name || 'TBA',
          address: {
            '@type':         'PostalAddress',
            streetAddress:   physical?.addressLine1 || '',
            addressLocality: physical?.city         || '',
            addressRegion:   physical?.state        || '',
            postalCode:      physical?.pincode      || '',
            addressCountry:  physical?.country      || 'IN',
          },
        }

  return {
    '@context': 'https://schema.org',
    '@type':    'Event',
    name:        ed.info?.name      || 'Event',
    description: ed.info?.shortDesc || stripMarkdown(ed.info?.fullDesc) || '',
    image:       eventImageUrls(ed).bannerUrl || eventImageUrls(ed).logoUrl || '',
    url:         `${BASE_URL}/events/${slug}`,
    startDate: ed.schedule?.startDate
      ? `${ed.schedule.startDate}T${ed.schedule.startTime || '00:00'}:00`
      : undefined,
    endDate: ed.schedule?.endDate
      ? `${ed.schedule.endDate}T${ed.schedule.endTime || '23:59'}:00`
      : undefined,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode:
      venueType === 'online'
        ? 'https://schema.org/OnlineEventAttendanceMode'
        : venueType === 'hybrid'
          ? 'https://schema.org/MixedEventAttendanceMode'
          : 'https://schema.org/OfflineEventAttendanceMode',
    location,
    organizer: organizer?.name
      ? { '@type': 'Organization', name: organizer.name, email: organizer.email || undefined }
      : undefined,
    offers: passes.map(pass => ({
      '@type':       'Offer',
      name:          pass.name,
      price:         pass.effectivePrice ?? pass.price,
      priceCurrency: 'INR',
      availability:  'https://schema.org/InStock',
      url:           `${BASE_URL}/events/${slug}`,
    })),
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function EventPage({ params }: PageProps) {
  const { slug } = await params

  const event = await findPublicEvent(slug)
  // The public boundary — existence, the lifecycle ALLOW-LIST (so an unrecognised or
  // future state can never leak), and admin moderation — now lives in ONE place:
  // lib/events/publicEventAccess. generateMetadata has already thrown a real 404 for
  // anything failing it; this keeps the rule impossible to skip if that path ever changes.
  if (!event) notFound()

  // The template props come from the ONE mapping the Super Admin pre-approval preview also
  // uses (lib/events/eventPageProps), so what an admin approves is what this page renders.
  const data = await loadEventPageData(slug, event)
  const { props, passes } = buildEventPageProps(slug, event, data)
  const ed = event.eventDetails as unknown as EventDetailsDraft

  // ── JSON-LD ────────────────────────────────────────────────────────────────
  const jsonLd = buildJsonLd(slug, ed, passes)

  return (
    <>
      {/* RD-RESULTS-PUBLIC-FIX-01 · shown only when this event has published results. */}
      <EventResultsBanner eventSlug={slug} />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // Escape '<' to prevent '</script>' injection inside JSON string values.
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <TemplateRouter {...props} />
      <div className="mx-auto max-w-3xl px-4 py-8 text-center">
        <ReportButton targetType="event" targetId={slug} label="Report this event" />
      </div>
    </>
  )
}
