import type { ReactNode } from 'react'
import { ArrowRight, Calendar, Heart, Target, Building2 } from 'lucide-react'
import type { CommunityDetails, OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import type { PassPublic } from '@/components/event-templates/types'

interface Card {
  icon:  ReactNode
  title: string
  body:  string
  href?: string
  cta:   string
}

function clip(text: string, max = 110): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function GetInvolvedSection({
  typeDetails, organizer, isFreeEvent, registrationOpen, passes,
}: {
  typeDetails:      Record<string, unknown> | null
  organizer?:       OrganizerInfo
  isFreeEvent:      boolean
  registrationOpen: boolean
  passes:           PassPublic[]
}) {
  const td          = typeDetails as CommunityDetails | null
  const activePasses = passes.filter(p => p.status !== 'inactive')
  const contactHref  = organizer?.email ? `mailto:${organizer.email}` : (organizer?.website || undefined)

  const cards: Card[] = []

  // Attend — always first if registration is live
  if (registrationOpen && activePasses.length > 0) {
    cards.push({
      icon:  <Calendar className="size-4 text-primary" aria-hidden />,
      title: isFreeEvent ? 'Attend for Free' : 'Get Your Ticket',
      body:  'Join us at the event and be part of this community initiative.',
      href:  '#tickets',
      cta:   isFreeEvent ? 'Claim Your Spot' : 'Register Now',
    })
  }

  // Volunteer — if instructions exist
  if (td?.volunteerInstructions?.trim()) {
    cards.push({
      icon:  <Heart className="size-4 text-primary" aria-hidden />,
      title: 'Volunteer',
      body:  clip(td.volunteerInstructions.trim()),
      href:  contactHref,
      cta:   'Get Involved',
    })
  }

  // Support the Cause — if cause/goal text exists
  if (td?.impactGoal?.trim() || td?.causeInfo?.trim()) {
    const text = (td.impactGoal?.trim() || td.causeInfo?.trim()) ?? ''
    cards.push({
      icon:  <Target className="size-4 text-primary" aria-hidden />,
      title: 'Support the Cause',
      body:  clip(text),
      href:  contactHref,
      cta:   'Learn More',
    })
  }

  // Become a Sponsor — if organiser contact exists
  if (organizer?.email || organizer?.website) {
    cards.push({
      icon:  <Building2 className="size-4 text-primary" aria-hidden />,
      title: 'Become a Sponsor',
      body:  'Support this community initiative as a sponsor or organisational partner.',
      href:  organizer?.email
        ? `mailto:${organizer.email}?subject=Sponsorship%20Enquiry`
        : organizer?.website,
      cta:   'Contact Us',
    })
  }

  if (cards.length === 0) return null

  const colClass =
    cards.length <= 2 ? 'grid-cols-1 sm:grid-cols-2' :
    cards.length === 3 ? 'grid-cols-1 sm:grid-cols-3' :
                         'grid-cols-2 sm:grid-cols-4'

  return (
    <section className="py-10 sm:py-12" aria-label="Get Involved">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-primary">
        Get Involved
      </p>
      <h2 className="mb-6 text-[1.0625rem] font-bold text-foreground">
        Ways to Make a Difference
      </h2>

      <div className={`grid gap-3 ${colClass}`}>
        {cards.map((card, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card p-4 transition-shadow hover:shadow-sm"
          >
            <div className="mb-3 flex size-8 items-center justify-center rounded-lg bg-primary/10">
              {card.icon}
            </div>
            <p className="text-[0.875rem] font-semibold text-foreground">
              {card.title}
            </p>
            <p className="mt-1 text-[0.75rem] leading-relaxed text-muted-foreground">
              {card.body}
            </p>
            {card.href && (
              <a
                href={card.href}
                className="mt-3 inline-flex items-center gap-1 text-[0.75rem] font-semibold text-primary hover:underline"
              >
                {card.cta}
                <ArrowRight className="size-3" aria-hidden />
              </a>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
