// SpeakersSection — the people behind an event (renamed per event type by the caller,
// e.g. "Race Leadership" for sports). Consumes the shared Public Event Framework
// primitives (SectionShell / SectionHeader) — no legacy wrapper.

import { ExternalLink, Link2 } from 'lucide-react'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'
import {
  SectionShell, EventSectionHeader, CARD, CARD_HOVER, CARD_PAD_SM, GRID_GAP, TYPE,
} from '@/components/event-templates/shared/ui/framework'

export function SpeakersSection({ speakers, eyebrow, title = 'Speakers', subtitle }: {
  speakers:  Speaker[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}) {
  if (speakers.length === 0) return null

  return (
    <SectionShell maxW="6xl">
      <EventSectionHeader
        eyebrow={eyebrow}
        title={title}
        description={subtitle ?? `${speakers.length} speaker${speakers.length !== 1 ? 's' : ''}`}
      />

      <div className={cn('grid grid-cols-2 sm:grid-cols-3', GRID_GAP)}>
        {speakers.map(speaker => (
          <div
            key={speaker.id}
            className={cn('flex flex-col items-center gap-2.5 text-center', CARD, CARD_HOVER, CARD_PAD_SM)}
          >
            <div className="size-14 overflow-hidden rounded-full ring-2 ring-border ring-offset-2 ring-offset-background">
              {speaker.photoUrl ? (
                // Decorative: the <h3> below is the accessible name, so a populated alt
                // would announce the speaker twice.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={speaker.photoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div
                  aria-hidden
                  className="flex h-full w-full items-center justify-center text-lg font-bold text-white"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  {speaker.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="w-full">
              {/* h3 under the section's h2 — no level skipped. TYPE.cardTitle keeps the
                  rendering identical to the <p> it replaces (preflight resets headings). */}
              <h3 className={cn('truncate', TYPE.cardTitle)}>{speaker.name}</h3>
              {speaker.title   && <p className={cn('truncate', TYPE.metaSm)}>{speaker.title}</p>}
              {speaker.company && <p className="truncate text-fs-2xs font-semibold text-primary">{speaker.company}</p>}
            </div>
            {(speaker.social?.linkedin || speaker.social?.twitter) && (
              <div className="flex gap-2">
                {speaker.social.linkedin && (
                  <a href={speaker.social.linkedin} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on LinkedIn`}
                    className="rounded text-muted-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2">
                    <Link2 className="size-3" aria-hidden />
                  </a>
                )}
                {speaker.social.twitter && (
                  <a href={speaker.social.twitter} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on X`}
                    className="rounded text-muted-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2">
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </SectionShell>
  )
}
