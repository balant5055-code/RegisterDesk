import { EventDetailClient }   from '@/components/event-templates/fallback/EventDetailClient'
import type { EventDetailProps } from '@/components/event-templates/types'
import { CommunityTemplate }  from './community/CommunityTemplate'
import { ConferenceTemplate } from './conference/ConferenceTemplate'
import { SportsTemplate }     from './sports/SportsTemplate'
import { TeamSportsTemplate } from './sports/TeamSportsTemplate'
import { WorkshopTemplate }    from './workshop/WorkshopTemplate'
import { ExhibitionTemplate }  from './exhibition/ExhibitionTemplate'
import { CulturalTemplate }   from './cultural/CulturalTemplate'
import { AwardsTemplate }    from './awards/AwardsTemplate'
import { MeetupTemplate }    from './meetup/MeetupTemplate'

export type { EventDetailProps }

// Running events use the run-specific SportsTemplate; every other sports subtype
// (hockey/football/cricket/cycling/… ) uses the dedicated TeamSportsTemplate.
const RUNNING_SPORT_SUBTYPES = new Set(['running', 'marathon', 'run'])

export function TemplateRouter(props: EventDetailProps) {
  if (props.eventType === 'community')  return <CommunityTemplate  {...props} />
  if (props.eventType === 'conference') return <ConferenceTemplate {...props} />
  if (props.eventType === 'sports')
    return RUNNING_SPORT_SUBTYPES.has(props.eventSubtype ?? '')
      ? <SportsTemplate     {...props} />
      : <TeamSportsTemplate {...props} />
  if (props.eventType === 'workshop')   return <WorkshopTemplate   {...props} />
  if (props.eventType === 'exhibition') return <ExhibitionTemplate {...props} />
  if (props.eventType === 'cultural')   return <CulturalTemplate   {...props} />
  if (props.eventType === 'awards')     return <AwardsTemplate     {...props} />
  if (props.eventType === 'meetup')     return <MeetupTemplate     {...props} />
  return <EventDetailClient {...props} />
}
