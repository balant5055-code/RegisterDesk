import { notFound }       from 'next/navigation'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { HomeShell }     from '@/components/discovery/home/HomeShell'
import SpeakerApplyClient from './SpeakerApplyClient'
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
  // RD-SEO-02 · this page is indexable and was the only public event sub-route with no
  // canonical, so a crawler reaching it through a tracked or query-stringed link had
  // nothing telling it which URL is the real one. `canonical()` is the shared helper every
  // marketing page already resolves its URL through (lib/marketing/seo.ts), so there is one
  // definition of the site's base URL rather than a second copy declared here.
  //
  // Title is unchanged, and nothing else is added: no description, no Open Graph, no robots
  // directive. This route had none of those before and gaining them is not a canonical fix.
  // RD-SEO-03 · a PRIVATE parent event makes this page non-indexable too.
  //
  // The rule is not invented here. `lib/events/publicVisibility.ts` names the "speaker/sponsor
  // application" as one of the public surfaces it governs; the sitemap withholds a private
  // event's URLs; and the event detail page has carried this exact directive since RD-SEO-01,
  // for the stated reason that a private event stays reachable by its link but must never be
  // indexed. This route applied the LIFECYCLE half of that contract (canExposePublicEvent 404s
  // a non-public status in the body) and silently dropped the VISIBILITY half — so a published
  // invite-only event kept an indexable /speak page advertising it, which is the one path in
  // that the parent's directive and the sitemap were both closing.
  //
  // Same expression as the parent route, deliberately, so the two cannot drift. `event?.` and
  // not `event.`: this function tolerates a missing event and returns a fallback title.
  return {
    title:      `Apply to Speak – ${name}`,
    alternates: { canonical: canonical(`/events/${slug}/speak`) },
    robots:     event?.visibility === 'private' ? { index: false, follow: false } : undefined,
  }
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
    <HomeShell>
      <SpeakerApplyClient
        slug={slug}
        eventName={eventName}
        enabled={enabled}
        closingDate={closingDate}
        customMessage={message}
      />
    </HomeShell>
  )
}
