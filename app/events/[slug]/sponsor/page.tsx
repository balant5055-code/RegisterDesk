import { notFound }       from 'next/navigation'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { HomeShell }     from '@/components/discovery/home/HomeShell'
import SponsorApplyClient from './SponsorApplyClient'
import { canonical }      from '@/lib/marketing/seo'
import type { Metadata }  from 'next'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const event    = await getEventBySlug(slug)
  const ed       = event?.eventDetails as Record<string, unknown> | null
  const name     = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : 'Event'
  // RD-SEO-02 · see the sibling /speak route — same gap, same fix, same helper, so the two
  // public application pages resolve their canonical URL identically.
  //
  // Title is unchanged, and nothing else is added: no description, no Open Graph, no robots
  // directive. This route had none of those before and gaining them is not a canonical fix.
  // RD-SEO-03 · a PRIVATE parent event makes this page non-indexable too — see the sibling
  // /speak route for the full reasoning. Same expression as the parent event page, so the
  // three surfaces that describe one event cannot disagree about whether it may be indexed.
  return {
    title:      `Become a Sponsor – ${name}`,
    alternates: { canonical: canonical(`/events/${slug}/sponsor`) },
    robots:     event?.visibility === 'private' ? { index: false, follow: false } : undefined,
  }
}

export default async function SponsorPage({ params }: Props) {
  const { slug } = await params
  const event    = await getEventBySlug(slug)

  if (!event || !canExposePublicEvent(event.lifecycleStatus)) {
    notFound()
  }

  const ed           = event.eventDetails as Record<string, unknown> | null
  const applications = ed?.applications   as Record<string, unknown> | null
  const sponsorCfg   = applications?.sponsor as Record<string, unknown> | null
  const enabled      = sponsorCfg?.enabled === true

  const eventName   = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : slug
  const closingDate = typeof sponsorCfg?.closingDate === 'string' ? sponsorCfg.closingDate : ''
  const message     = typeof sponsorCfg?.message     === 'string' ? sponsorCfg.message     : ''

  return (
    <HomeShell>
      <SponsorApplyClient
        slug={slug}
        eventName={eventName}
        enabled={enabled}
        closingDate={closingDate}
        customMessage={message}
      />
    </HomeShell>
  )
}
