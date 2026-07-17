import { EventDetailClient }   from '@/app/events/[slug]/EventDetailClient'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import { CommunityTemplate }  from './community/CommunityTemplate'
import { ConferenceTemplate } from './conference/ConferenceTemplate'
import { SportsTemplate }     from './sports/SportsTemplate'
import { WorkshopTemplate }    from './workshop/WorkshopTemplate'
import { ExhibitionTemplate }  from './exhibition/ExhibitionTemplate'
import { CulturalTemplate }   from './cultural/CulturalTemplate'
import { AwardsTemplate }    from './awards/AwardsTemplate'

export type { EventDetailProps }

export function TemplateRouter(props: EventDetailProps) {
  if (props.eventType === 'community')  return <CommunityTemplate  {...props} />
  if (props.eventType === 'conference') return <ConferenceTemplate {...props} />
  if (props.eventType === 'sports')     return <SportsTemplate     {...props} />
  if (props.eventType === 'workshop')   return <WorkshopTemplate   {...props} />
  if (props.eventType === 'exhibition') return <ExhibitionTemplate {...props} />
  if (props.eventType === 'cultural')   return <CulturalTemplate   {...props} />
  if (props.eventType === 'awards')     return <AwardsTemplate     {...props} />
  return <EventDetailClient {...props} />
}
