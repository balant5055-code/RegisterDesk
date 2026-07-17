'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Clock, MapPin } from 'lucide-react'
import type { AgendaSession, Speaker } from '@/components/wizard/eventDetailsConfig'

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${(m ?? 0).toString().padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

function fmtDayDate(dateStr: string) {
  if (!dateStr || dateStr === '_') return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  })
}

const SESSION_DOT: Record<string, string> = {
  keynote:    'bg-rose-400',
  panel:      'bg-violet-400',
  workshop:   'bg-amber-400',
  networking: 'bg-teal-400',
  session:    'bg-blue-400',
  labs:       'bg-indigo-400',
  break:      'bg-gray-300',
  custom:     'bg-gray-400',
}

export function CommunityEventJourney({
  agenda, speakers = [],
}: {
  agenda:    AgendaSession[]
  speakers?: Speaker[]
}) {
  const sessions = agenda.filter(s => !s.isBreak)
  if (sessions.length === 0) return null

  const speakerMap = Object.fromEntries(speakers.map(s => [s.id, s]))

  const byDate = sessions.reduce<Record<string, AgendaSession[]>>((acc, s) => {
    const key = s.date?.trim() || '_'
    ;(acc[key] ??= []).push(s)
    return acc
  }, {})

  const dates     = Object.keys(byDate).sort()
  const multiDay  = dates.length > 1
  const [activeDate, setActiveDate] = useState(dates[0] ?? '_')

  const activeSessions = (byDate[activeDate] ?? []).sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order
    return (a.startTime ?? '').localeCompare(b.startTime ?? '')
  })

  return (
    <section className="bg-white py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        {/* Heading */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5 }}
          className="mb-7"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            Event Programme
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            What's happening
          </h2>
        </motion.div>

        {/* Day selector (multi-day only) */}
        {multiDay && (
          <div className="mb-6 flex flex-wrap gap-2">
            {dates.map((date, i) => {
              const isActive = date === activeDate
              return (
                <button
                  key={date}
                  onClick={() => setActiveDate(date)}
                  className={`rounded-xl px-4 py-2 text-[0.8125rem] font-bold transition-all duration-200 ${
                    isActive
                      ? 'bg-gray-900 text-white shadow-sm'
                      : 'bg-white text-gray-600 ring-1 ring-black/8 hover:ring-black/14 hover:shadow-sm'
                  }`}
                >
                  Day {i + 1}
                  {date !== '_' && (
                    <span className={`ml-1.5 font-medium ${isActive ? 'text-white/70' : 'text-gray-400'}`}>
                      {fmtDayDate(date)}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {/* Session list */}
        <AnimatePresence mode="wait">
          <motion.div
            key={activeDate}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25 }}
            className="space-y-2"
          >
            {activeSessions.map((session, i) => {
              const dot = SESSION_DOT[session.type] ?? SESSION_DOT.custom!
              const sessionSpeakers = (session.speakerIds ?? [])
                .map(id => speakerMap[id])
                .filter(Boolean) as Speaker[]

              return (
                <motion.div
                  key={session.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.35 }}
                  className="group flex gap-4 rounded-2xl bg-white p-4 ring-1 ring-black/5 transition-all hover:ring-black/10 hover:shadow-sm"
                >
                  {/* Time column */}
                  {session.startTime ? (
                    <div className="w-[72px] shrink-0 pt-0.5">
                      <p className="text-[0.75rem] font-bold tabular-nums text-gray-900 leading-none">
                        {fmtTime(session.startTime)}
                      </p>
                      {session.endTime && (
                        <p className="mt-0.5 text-[0.6875rem] tabular-nums text-gray-400">
                          {fmtTime(session.endTime)}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex w-6 shrink-0 flex-col items-center pt-2">
                      <div className={`size-2 rounded-full ${dot}`} aria-hidden />
                      {i < activeSessions.length - 1 && (
                        <div className="mt-1.5 w-px flex-1 bg-gray-100" aria-hidden />
                      )}
                    </div>
                  )}

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      {/* Type badge */}
                      <span className="rounded-md bg-gray-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500 ring-1 ring-black/5 capitalize">
                        {session.type}
                      </span>
                      {session.track && (
                        <span className="text-[10px] font-medium text-gray-400">{session.track}</span>
                      )}
                    </div>

                    <h3 className="text-[0.875rem] font-bold leading-snug text-gray-900">
                      {session.title}
                    </h3>

                    {sessionSpeakers.length > 0 && (
                      <p className="mt-1 text-[0.75rem] font-semibold text-primary/80">
                        {sessionSpeakers.map(s => s.name).join(' · ')}
                      </p>
                    )}

                    {session.description && (
                      <p className="mt-1 text-[0.8125rem] leading-relaxed text-gray-500">
                        {session.description}
                      </p>
                    )}

                    {session.location && (
                      <p className="mt-1.5 flex items-center gap-1 text-[0.75rem] text-gray-400">
                        <MapPin className="size-3" aria-hidden />
                        {session.location}
                      </p>
                    )}
                  </div>

                  {/* Duration indicator (if both times exist) */}
                  {session.startTime && session.endTime && (
                    <div className="hidden shrink-0 items-center gap-1 text-[0.75rem] text-gray-400 sm:flex">
                      <Clock className="size-3" aria-hidden />
                      {(() => {
                        const [sh, sm] = session.startTime.split(':').map(Number)
                        const [eh, em] = session.endTime.split(':').map(Number)
                        const diff = (eh! * 60 + em!) - (sh! * 60 + sm!)
                        return diff > 0 ? `${diff}m` : null
                      })()}
                    </div>
                  )}
                </motion.div>
              )
            })}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}
