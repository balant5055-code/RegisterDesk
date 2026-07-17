import { notFound }       from 'next/navigation'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import SponsorApplyClient from './SponsorApplyClient'
import type { Metadata }  from 'next'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const event    = await getEventBySlug(slug)
  const ed       = event?.eventDetails as Record<string, unknown> | null
  const name     = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : 'Event'
  return { title: `Become a Sponsor – ${name}` }
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
    <SponsorApplyClient
      slug={slug}
      eventName={eventName}
      enabled={enabled}
      closingDate={closingDate}
      customMessage={message}
    />
  )
}
