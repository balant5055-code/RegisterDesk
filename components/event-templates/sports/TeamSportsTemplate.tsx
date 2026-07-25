'use client'

// RD-ATTENDEE-01 Phase 2 — Team Sports is now a lightweight CONFIG over the shared
// EventDetailsFramework. It contributes only its type-specific TournamentSection (match
// format, team/squad size, ground/court, rules) before registration; the framework owns
// everything else. (The running SportsTemplate stays as the frozen canonical template.)

import { ExternalLink } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import { EventDetailsFramework } from '@/components/event-templates/EventDetailsFramework'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'
import type { TeamSportDetails } from '@/components/wizard/eventDetailsConfig'

function TournamentSection({ td }: { td: Partial<TeamSportDetails> | null }) {
  if (!td) return null
  const facts = [
    td.matchFormat?.trim()   && { label: 'Match format',   value: td.matchFormat!.trim() },
    td.teamSize != null      && { label: 'Team size',      value: `${td.teamSize} players` },
    td.squadSize != null     && { label: 'Squad size',     value: `${td.squadSize} players` },
    td.matchDuration?.trim() && { label: 'Match duration', value: td.matchDuration!.trim() },
    td.overs != null         && { label: 'Overs',          value: `${td.overs}` },
  ].filter(Boolean) as { label: string; value: string }[]
  const notes = [
    td.groundInfo?.trim() && { label: 'Ground', value: td.groundInfo!.trim() },
    td.courtInfo?.trim()  && { label: 'Court',  value: td.courtInfo!.trim() },
  ].filter(Boolean) as { label: string; value: string }[]

  if (facts.length === 0 && notes.length === 0 && !td.rulesUrl?.trim()) return null

  return (
    <SectionShell id="tournament" maxW="4xl" bg="muted">
      <SectionHeader eyebrow="Tournament" title="Match & team details" />
      {facts.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {facts.map((f, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{f.label}</p>
              <p className="mt-1 text-sm font-semibold text-foreground">{f.value}</p>
            </div>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <ul className="space-y-3">
          {notes.map((n, i) => (
            <li key={i}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{n.label}</p>
              <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">{n.value}</p>
            </li>
          ))}
        </ul>
      )}
      {td.rulesUrl?.trim() && (
        <a href={td.rulesUrl.trim()} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline">
          Tournament rules
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
    </SectionShell>
  )
}

export function TeamSportsTemplate(props: EventDetailProps) {
  const td = props.typeDetails as Partial<TeamSportDetails> | null
  return (
    <EventDetailsFramework
      props={props}
      eventType="sports"
      heroKicker={props.eventSubtype ?? undefined}
      aboutEyebrow="About"
      aboutTitle="About this tournament"
      scheduleEyebrow="Schedule"
      scheduleTitle="Fixtures & timings"
      scheduleSubtitle="How the tournament unfolds."
      registrationTargetId="tickets"
      completedMessage="This event has concluded. Thank you to all who participated!"
      slots={{ beforeRegistration: <TournamentSection td={td} /> }}
    />
  )
}
