'use client'

import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Building2, Mic2 } from 'lucide-react'
import { FaLinkedinIn, FaTwitter } from 'react-icons/fa'
import type { Speaker, AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceSpeakers({
  speakers,
  agenda,
}: {
  speakers: Speaker[]
  agenda:   AgendaSession[]
}) {
  if (!speakers.length) return null

  const sorted = [...speakers].sort((a, b) => a.order - b.order)
  const keynote = sorted[0]!
  const rest    = sorted.slice(1)

  // Map speakerId → first session title they're presenting
  const sessionBySpeaker = useMemo(() => {
    const map: Record<string, string> = {}
    agenda.forEach(s => {
      if (!s.isBreak && s.title?.trim()) {
        s.speakerIds?.forEach(id => {
          if (!map[id]) map[id] = s.title
        })
      }
    })
    return map
  }, [agenda])

  return (
    <section id="speakers" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">
            Speakers
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Learn from the Best
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Visionaries, founders, and domain experts sharing what&apos;s next.
          </p>
        </motion.div>

        {/* Featured keynote */}
        <KeynoteSpeakerCard speaker={keynote} sessionTitle={sessionBySpeaker[keynote.id]} />

        {/* Speaker grid */}
        {rest.length > 0 && (
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4 lg:gap-6">
            {rest.map((speaker, i) => (
              <motion.div
                key={speaker.id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.05 }}
                transition={{ duration: 0.45, delay: Math.min(i, 7) * 0.055, ease: [0.25, 0, 0, 1] }}
              >
                <SpeakerCard speaker={speaker} sessionTitle={sessionBySpeaker[speaker.id]} />
              </motion.div>
            ))}
          </div>
        )}

      </div>
    </section>
  )
}

// ─── Keynote speaker card ──────────────────────────────────────────────────────

function KeynoteSpeakerCard({ speaker, sessionTitle }: { speaker: Speaker; sessionTitle?: string }) {
  const initials = speaker.name
    .split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.05 }}
      transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
      className="overflow-hidden rounded-3xl border border-gray-100 bg-gradient-to-br from-gray-50 to-white shadow-[0_8px_40px_-12px_rgba(0,0,0,0.12)]"
    >
      <div className="grid sm:grid-cols-[220px_1fr] lg:grid-cols-[300px_1fr]">

        {/* Photo */}
        <div className="overflow-hidden bg-gray-100">
          {speaker.photoUrl?.trim() ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={speaker.photoUrl}
              alt={speaker.name}
              className="aspect-square w-full object-cover sm:aspect-auto sm:h-full"
            />
          ) : (
            <div
              className="flex aspect-square w-full items-center justify-center text-4xl font-black text-white sm:aspect-auto sm:h-full sm:min-h-[240px]"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {initials}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex flex-col justify-center p-7 lg:p-10">
          <span className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/20 bg-primary/[0.05] px-3 py-1 text-[10.5px] font-bold uppercase tracking-[0.18em] text-primary">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            Keynote Speaker
          </span>

          <h3 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            {speaker.name}
          </h3>
          {speaker.title && (
            <p className="mt-1 text-sm text-gray-500">{speaker.title}</p>
          )}
          {speaker.company && (
            <div className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-lg bg-gray-50 px-2.5 py-1 ring-1 ring-gray-100">
              <Building2 className="size-3 text-gray-400" aria-hidden />
              <span className="text-[11.5px] font-semibold text-gray-600">{speaker.company}</span>
            </div>
          )}
          {speaker.bio?.trim() && (
            <p className="mt-4 line-clamp-3 text-[0.875rem] leading-relaxed text-gray-500">
              {speaker.bio}
            </p>
          )}
          {sessionTitle && (
            <div className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-lg bg-primary/[0.06] px-3 py-1.5">
              <Mic2 className="size-3.5 text-primary" aria-hidden />
              <span className="text-[11.5px] font-semibold text-primary">{sessionTitle}</span>
            </div>
          )}

          {(speaker.social?.linkedin || speaker.social?.twitter) && (
            <div className="mt-5 flex items-center gap-2">
              {speaker.social.linkedin && (
                <a
                  href={speaker.social.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${speaker.name} on LinkedIn`}
                  className="flex size-8 items-center justify-center rounded-lg bg-white text-gray-400 ring-1 ring-gray-200 transition-colors hover:bg-primary/[0.08] hover:text-primary"
                >
                  <FaLinkedinIn className="size-3.5" aria-hidden />
                </a>
              )}
              {speaker.social.twitter && (
                <a
                  href={speaker.social.twitter}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${speaker.name} on X`}
                  className="flex size-8 items-center justify-center rounded-lg bg-white text-gray-400 ring-1 ring-gray-200 transition-colors hover:bg-primary/[0.08] hover:text-primary"
                >
                  <FaTwitter className="size-3.5" aria-hidden />
                </a>
              )}
            </div>
          )}
        </div>

      </div>
    </motion.div>
  )
}

// ─── Regular speaker card ──────────────────────────────────────────────────────

function SpeakerCard({ speaker, sessionTitle }: { speaker: Speaker; sessionTitle?: string }) {
  const initials = speaker.name
    .split(' ').slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')

  return (
    <div className="group flex flex-col rounded-2xl border border-gray-100 bg-white p-4 transition-all duration-200 hover:border-gray-200 hover:shadow-[0_12px_40px_-8px_rgba(0,0,0,0.11)] sm:p-5">

      {/* Photo */}
      <div className="mb-4 overflow-hidden rounded-xl bg-gray-50">
        <div className="aspect-square w-full">
          {speaker.photoUrl?.trim() ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={speaker.photoUrl}
              alt={speaker.name}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-xl font-black text-white"
              style={{ backgroundImage: 'var(--primary-gradient)' }}
            >
              {initials}
            </div>
          )}
        </div>
      </div>

      {/* Info */}
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="line-clamp-1 text-[0.9375rem] font-bold text-gray-950">{speaker.name}</p>
        {speaker.title && (
          <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">{speaker.title}</p>
        )}
        {speaker.company && (
          <div className="mt-1.5 inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-gray-50 px-2 py-0.5 ring-1 ring-gray-100">
            <Building2 className="size-2.5 shrink-0 text-gray-400" aria-hidden />
            <span className="truncate text-[10.5px] font-semibold text-gray-600">{speaker.company}</span>
          </div>
        )}
        {sessionTitle && (
          <div className="mt-1.5 inline-flex w-fit max-w-full items-center gap-1 rounded-md bg-primary/[0.05] px-2 py-0.5">
            <Mic2 className="size-2.5 shrink-0 text-primary" aria-hidden />
            <span className="truncate text-[10.5px] font-semibold text-primary">{sessionTitle}</span>
          </div>
        )}

        {(speaker.social?.linkedin || speaker.social?.twitter) && (
          <div className="mt-3 flex items-center gap-2">
            {speaker.social.linkedin && (
              <a
                href={speaker.social.linkedin}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${speaker.name} on LinkedIn`}
                className="flex size-7 items-center justify-center rounded-lg bg-gray-50 text-gray-400 ring-1 ring-gray-100 transition-colors hover:bg-primary/[0.08] hover:text-primary"
              >
                <FaLinkedinIn className="size-3.5" aria-hidden />
              </a>
            )}
            {speaker.social.twitter && (
              <a
                href={speaker.social.twitter}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${speaker.name} on X`}
                className="flex size-7 items-center justify-center rounded-lg bg-gray-50 text-gray-400 ring-1 ring-gray-100 transition-colors hover:bg-primary/[0.08] hover:text-primary"
              >
                <FaTwitter className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>

    </div>
  )
}
