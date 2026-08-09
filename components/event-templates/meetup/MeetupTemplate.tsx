'use client'

// RD-ATTENDEE-01 Phase 2 — Meetup is now a lightweight CONFIG over the shared
// EventDetailsFramework. It contributes only its type-specific MeetupSection; the
// framework owns the hero, registration, about, schedule, venue, organizer, gallery,
// sponsors, event-info, FAQ, sticky CTA, ordering and chrome.

import type { LucideIcon } from 'lucide-react'
import { Sparkles, Rocket, Users2 } from 'lucide-react'
import type { EventDetailProps } from '@/components/event-templates/types'
import { EventDetailsFramework } from '@/components/event-templates/EventDetailsFramework'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'
import type { MeetupFounderDetails, MeetupCorporateDetails, MeetupAlumniDetails } from '@/components/wizard/eventDetailsConfig'

type MeetupTd = Partial<MeetupFounderDetails & MeetupCorporateDetails & MeetupAlumniDetails>

function MeetupSection({ td }: { td: MeetupTd | null }) {
  if (!td) return null
  const features = [
    td.startupShowcaseEnabled && { icon: Sparkles, label: 'Startup Showcase' },
    td.pitchSessionEnabled    && { icon: Rocket,   label: td.pitchFormat?.trim() ? `Pitch Session — ${td.pitchFormat.trim()}` : 'Pitch Session' },
    td.investorConnectEnabled && { icon: Users2,   label: 'Investor Connect' },
  ].filter(Boolean) as { icon: LucideIcon; label: string }[]
  const guests = (td.guestSpeakers ?? []).filter(g => g?.trim())
  const rows = [
    td.networkingAgenda?.trim()  && { label: 'Networking',         value: td.networkingAgenda!.trim() },
    td.institution?.trim()       && { label: 'Institution',        value: td.institution!.trim() },
    td.batchYears?.trim()        && { label: 'Batch years',        value: td.batchYears!.trim() },
    td.reunionActivities?.trim() && { label: 'Reunion activities', value: td.reunionActivities!.trim() },
  ].filter(Boolean) as { label: string; value: string }[]

  if (features.length === 0 && guests.length === 0 && rows.length === 0) return null

  return (
    <SectionShell id="meetup-info" maxW="4xl" bg="muted">
      <SectionHeader eyebrow="The Meetup" title="What to expect" />
      {features.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {features.map(({ icon: Icon, label }, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground">
              <Icon className="size-3.5 text-primary" aria-hidden />{label}
            </span>
          ))}
        </div>
      )}
      {guests.length > 0 && (
        <div className="mb-5">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Guest speakers</p>
          <p className="text-sm text-foreground">{guests.join(' · ')}</p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="space-y-3">
          {rows.map((r, i) => (
            <li key={i}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{r.label}</p>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{r.value}</p>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  )
}

export function MeetupTemplate(props: EventDetailProps) {
  const td = props.typeDetails as MeetupTd | null
  return (
    <EventDetailsFramework
      props={props}
      eventType="meetup"
      aboutEyebrow="About"
      aboutTitle="About this meetup"
      scheduleEyebrow="Agenda"
      scheduleTitle="What's happening"
      scheduleSubtitle="How the meetup unfolds."
      registrationTargetId="tickets"
      slots={{ afterAbout: <MeetupSection td={td} /> }}
    />
  )
}
