// SpeakersSection — the people behind an event (renamed per event type by the caller,
// e.g. "Race Leadership" for sports). Consumes the shared Public Event Framework
// primitives (SectionShell / SectionHeader) — no legacy wrapper.

import { ExternalLink, Link2 } from 'lucide-react'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'

export function SpeakersSection({ speakers, eyebrow, title = 'Speakers', subtitle }: {
  speakers:  Speaker[]
  eyebrow?:  string
  title?:    string
  subtitle?: string
}) {
  if (speakers.length === 0) return null

  return (
    <SectionShell maxW="6xl">
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle ?? `${speakers.length} speaker${speakers.length !== 1 ? 's' : ''}`}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {speakers.map(speaker => (
          <div
            key={speaker.id}
            className="flex flex-col items-center gap-2.5 rounded-xl border border-border/60 bg-background p-4 text-center transition-shadow hover:shadow-[var(--shadow-sm)]"
          >
            <div className="size-14 overflow-hidden rounded-full ring-2 ring-border ring-offset-2 ring-offset-background">
              {speaker.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={speaker.photoUrl} alt={speaker.name} className="h-full w-full object-cover" />
              ) : (
                <div
                  className="flex h-full w-full items-center justify-center text-lg font-bold text-white"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  {speaker.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <div className="w-full">
              <p className="truncate text-xs font-bold text-foreground">{speaker.name}</p>
              {speaker.title   && <p className="truncate text-[10px] text-muted-foreground">{speaker.title}</p>}
              {speaker.company && <p className="truncate text-[10px] font-semibold text-primary">{speaker.company}</p>}
            </div>
            {(speaker.social?.linkedin || speaker.social?.twitter) && (
              <div className="flex gap-2">
                {speaker.social.linkedin && (
                  <a href={speaker.social.linkedin} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on LinkedIn`}
                    className="text-muted-foreground transition-colors hover:text-primary">
                    <Link2 className="size-3" aria-hidden />
                  </a>
                )}
                {speaker.social.twitter && (
                  <a href={speaker.social.twitter} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on X`}
                    className="text-muted-foreground transition-colors hover:text-primary">
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
