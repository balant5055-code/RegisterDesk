'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { MapPin, Clock } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { AgendaSession, Speaker, ConferenceTrack } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

function sessionDuration(start: string, end: string) {
  if (!start || !end) return ''
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const mins = (eh! * 60 + em!) - (sh! * 60 + sm!)
  if (mins <= 0) return ''
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''}`
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ConferenceAgendaProps {
  agenda:   AgendaSession[]
  speakers: Speaker[]
  tracks:   ConferenceTrack[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceAgenda({ agenda, speakers, tracks }: ConferenceAgendaProps) {
  const sorted = useMemo(() =>
    [...agenda]
      .filter(s => s.title?.trim())
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`)),
    [agenda],
  )

  const dates = useMemo(() => [...new Set(sorted.map(s => s.date))].sort(), [sorted])
  const [activeDate,  setActiveDate]  = useState<string>(dates[0] ?? '')
  const [activeTrack, setActiveTrack] = useState<string>('all')

  const tracksInDate = useMemo(() => {
    const sessions = sorted.filter(s => s.date === activeDate && !s.isBreak && s.track)
    return [...new Set(sessions.map(s => s.track).filter(Boolean))]
  }, [sorted, activeDate])

  const filtered = useMemo(() =>
    sorted.filter(s =>
      s.date === activeDate &&
      (activeTrack === 'all' || s.track === activeTrack || s.isBreak),
    ),
    [sorted, activeDate, activeTrack],
  )

  const speakerMap = useMemo(() =>
    Object.fromEntries(speakers.map(sp => [sp.id, sp])),
    [speakers],
  )

  if (!sorted.length) return null

  return (
    <section id="schedule" className="bg-gray-50 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Programme</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Event Schedule
          </h2>
          <p className="mt-2 text-base text-gray-500">
            {sorted.filter(s => !s.isBreak).length} sessions
            {dates.length > 1 ? ` across ${dates.length} days` : ''}
          </p>
        </motion.div>

        {/* Day tabs — sliding indicator bar */}
        {dates.length > 1 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4 }}
            className="mb-7"
          >
            <div className="flex overflow-x-auto rounded-2xl bg-gray-200/60 p-1.5">
              {dates.map((date, dateIdx) => (
                <button
                  key={date}
                  type="button"
                  onClick={() => { setActiveDate(date); setActiveTrack('all') }}
                  className="relative flex flex-1 shrink-0 flex-col items-center gap-0.5 rounded-xl px-4 py-3 transition-colors duration-150 focus-visible:outline-none"
                >
                  {activeDate === date && (
                    <motion.div
                      layoutId="conf-day-tab"
                      className="absolute inset-0 rounded-xl bg-white shadow-[0_2px_8px_-2px_rgba(0,0,0,0.10)]"
                      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    />
                  )}
                  <span className={cn(
                    'relative z-10 text-[10px] font-bold uppercase tracking-widest transition-colors duration-150',
                    activeDate === date ? 'text-primary' : 'text-gray-400',
                  )}>
                    Day {dateIdx + 1}
                  </span>
                  <span className={cn(
                    'relative z-10 text-[0.875rem] font-semibold transition-colors duration-150',
                    activeDate === date ? 'text-gray-950' : 'text-gray-500',
                  )}>
                    {fmtDate(date)}
                  </span>
                  <span className={cn(
                    'relative z-10 text-[10.5px] transition-colors duration-150',
                    activeDate === date ? 'text-gray-400' : 'text-gray-300',
                  )}>
                    {sorted.filter(s => s.date === date && !s.isBreak).length} sessions
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Track filter */}
        {tracksInDate.length > 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mb-6 flex flex-wrap gap-2"
          >
            <button
              type="button"
              onClick={() => setActiveTrack('all')}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-150',
                activeTrack === 'all'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-500 ring-1 ring-gray-200 hover:ring-gray-300',
              )}
            >
              All Tracks
            </button>
            {tracksInDate.map(trackName => {
              const track    = tracks.find(t => t.name === trackName)
              const isActive = activeTrack === trackName
              return (
                <button
                  key={trackName}
                  type="button"
                  onClick={() => setActiveTrack(trackName)}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-150',
                    isActive
                      ? 'text-white'
                      : 'bg-white text-gray-500 ring-1 ring-gray-200 hover:ring-gray-300',
                  )}
                  style={isActive
                    ? { backgroundColor: track?.color ?? '#111', color: '#fff' }
                    : {}}
                >
                  {trackName}
                </button>
              )
            })}
          </motion.div>
        )}

        {/* Sessions */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${activeDate}-${activeTrack}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22 }}
            className="flex flex-col gap-2"
          >
            {filtered.map((session, idx) => {

              if (session.isBreak) {
                return (
                  <div key={session.id} className="flex items-center gap-3 py-1">
                    <span className="min-w-[72px] text-right text-[11px] font-semibold text-gray-400 tabular-nums">
                      {fmtTime(session.startTime)}
                    </span>
                    <div className="h-px flex-1 border-t border-dashed border-gray-200" />
                    <span className="shrink-0 rounded-full bg-gray-100 px-3 py-1 text-[11px] font-medium text-gray-400">
                      {session.title}
                    </span>
                    <div className="h-px flex-1 border-t border-dashed border-gray-200" />
                  </div>
                )
              }

              const sessionSpeakers = (session.speakerIds ?? [])
                .map(id => speakerMap[id])
                .filter(Boolean) as Speaker[]

              const track = tracks.find(t => t.name === session.track)

              return (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(idx, 8) * 0.03 }}
                  className="flex gap-4"
                >
                  {/* Time column */}
                  <div className="w-[72px] shrink-0 pt-[18px] text-right">
                    <p className="text-[11.5px] font-bold tabular-nums text-gray-400">
                      {fmtTime(session.startTime)}
                    </p>
                    {session.endTime && (
                      <p className="mt-0.5 text-[10px] text-gray-300">
                        –{fmtTime(session.endTime)}
                      </p>
                    )}
                  </div>

                  {/* Session card */}
                  <div className="flex-1 rounded-2xl border border-gray-100 bg-white p-4 transition-all duration-150 hover:border-gray-200 hover:shadow-sm sm:p-5">

                    {/* Badges row */}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      {session.track && (
                        <span
                          className="rounded-full px-2.5 py-0.5 text-[10.5px] font-bold"
                          style={track?.color
                            ? { backgroundColor: `${track.color}18`, color: track.color }
                            : { backgroundColor: 'var(--color-primary-50, #f0f0ff)', color: 'var(--color-primary, #7c3aed)' }}
                        >
                          {session.track}
                        </span>
                      )}
                      {session.endTime && (
                        <span className="flex items-center gap-1 text-[10.5px] text-gray-400">
                          <Clock className="size-3" aria-hidden />
                          {sessionDuration(session.startTime, session.endTime)}
                        </span>
                      )}
                      {session.location && (
                        <span className="flex items-center gap-1 text-[10.5px] text-gray-400">
                          <MapPin className="size-3" aria-hidden />
                          {session.location}
                        </span>
                      )}
                    </div>

                    {/* Title */}
                    <h4 className="text-[0.9375rem] font-bold leading-snug text-gray-900 sm:text-base">
                      {session.title}
                    </h4>

                    {/* Description */}
                    {session.description && (
                      <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-gray-500">
                        {session.description}
                      </p>
                    )}

                    {/* Speakers */}
                    {sessionSpeakers.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-2.5">
                        {sessionSpeakers.map(sp => (
                          <div key={sp.id} className="flex items-center gap-2">
                            <div className="size-6 overflow-hidden rounded-full bg-gray-100 ring-1 ring-gray-200">
                              {sp.photoUrl?.trim() ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={sp.photoUrl} alt={sp.name} className="h-full w-full object-cover" />
                              ) : (
                                <div
                                  className="flex h-full w-full items-center justify-center text-[8px] font-bold text-white"
                                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                                >
                                  {sp.name.charAt(0).toUpperCase()}
                                </div>
                              )}
                            </div>
                            <div>
                              <span className="text-[11.5px] font-semibold text-gray-700">{sp.name}</span>
                              {sp.company && (
                                <span className="ml-1 text-[11px] text-gray-400">&middot; {sp.company}</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                </motion.div>
              )
            })}

            {filtered.length === 0 && (
              <div className="py-12 text-center text-sm text-gray-400">
                No sessions for this selection.
              </div>
            )}
          </motion.div>
        </AnimatePresence>

      </div>
    </section>
  )
}
