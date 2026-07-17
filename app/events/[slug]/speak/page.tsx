import { notFound }       from 'next/navigation'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import SpeakerApplyClient from './SpeakerApplyClient'
import type { Metadata }  from 'next'

type Props = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const event    = await getEventBySlug(slug)
  const ed       = event?.eventDetails as Record<string, unknown> | null
  const name     = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : 'Event'
  return { title: `Apply to Speak – ${name}` }
}

export default async function SpeakPage({ params }: Props) {
  const { slug } = await params
  const event    = await getEventBySlug(slug)

  if (!event || !canExposePublicEvent(event.lifecycleStatus)) {
    notFound()
  }

  const ed           = event.eventDetails as Record<string, unknown> | null
  const applications = ed?.applications   as Record<string, unknown> | null
  const speakerCfg   = applications?.speaker as Record<string, unknown> | null
  const enabled      = speakerCfg?.enabled === true

  const eventName   = typeof (ed?.info as Record<string, unknown> | null)?.name === 'string'
    ? (ed!.info as Record<string, unknown>).name as string
    : slug
  const closingDate = typeof speakerCfg?.closingDate === 'string' ? speakerCfg.closingDate : ''
  const message     = typeof speakerCfg?.message     === 'string' ? speakerCfg.message     : ''

  return (
    <SpeakerApplyClient
      slug={slug}
      eventName={eventName}
      enabled={enabled}
      closingDate={closingDate}
      customMessage={message}
    />
  )
}
