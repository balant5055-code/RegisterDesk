'use client'

import { motion } from 'framer-motion'
import { Clock, MapPin, Trophy, Coffee, Star, CalendarDays } from 'lucide-react'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsCeremonyProps {
  agenda:          AgendaSession[]
  ceremonyFormat?: string
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t?: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

function groupByDate(sessions: AgendaSession[]) {
  const map = new Map<string, AgendaSession[]>()
  for (const s of sessions) {
    const key = s.date ?? 'TBD'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
}

const isAwardSession = (s: AgendaSession) =>
  /award|winner|trophy|recogni|honour|ceremony|gala|presentation/i.test(s.title)

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsCeremony({ agenda, ceremonyFormat }: AwardsCeremonyProps) {
  const hasAgenda  = agenda.length > 0
  const hasFormat  = !!ceremonyFormat?.trim()

  if (!hasAgenda && !hasFormat) return null

  const groups = groupByDate(agenda)

  return (
    <section className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-12"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Programme
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Ceremony Schedule
          </h2>
          {hasFormat && (
            <p className="mt-3 max-w-xl text-base text-zinc-400">{ceremonyFormat}</p>
          )}
        </motion.div>

        {hasAgenda && (
          <div className="space-y-10">
            {groups.map(([date, sessions], gi) => (
              <div key={date}>
                {/* Day label */}
                {groups.length > 1 && (
                  <motion.div
                    initial={{ opacity: 0, x: -10 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.35, delay: gi * 0.07 }}
                    className="mb-5 flex items-center gap-3"
                  >
                    <CalendarDays className="size-4 text-yellow-400" aria-hidden />
                    <span className="text-sm font-bold text-zinc-300">
                      {date === 'TBD' ? 'Schedule' : fmtDate(date)}
                    </span>
                    <div className="h-px flex-1 bg-zinc-800" />
                  </motion.div>
                )}

                {/* Timeline */}
                <div className="relative space-y-2 pl-6 before:absolute before:inset-y-2 before:left-2 before:w-px before:bg-zinc-800">
                  {sessions.map((s, si) => {
                    const isAward = isAwardSession(s)
                    const isBreak = s.isBreak

                    return (
                      <motion.div
                        key={s.id}
                        initial={{ opacity: 0, x: 10 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.3, delay: gi * 0.05 + si * 0.04 }}
                        className="relative"
                      >
                        {/* Timeline dot */}
                        <div className={`absolute -left-[18px] mt-[9px] flex size-4 items-center justify-center rounded-full ${
                          isAward ? 'bg-yellow-400' : isBreak ? 'bg-zinc-800 border border-zinc-700' : 'bg-zinc-800 border border-zinc-600'
                        }`}>
                          {isAward ? (
                            <Trophy className="size-2.5 text-zinc-950" aria-hidden />
                          ) : isBreak ? (
                            <Coffee className="size-2 text-zinc-600" aria-hidden />
                          ) : (
                            <div className="size-1.5 rounded-full bg-zinc-500" />
                          )}
                        </div>

                        {isBreak ? (
                          <div className="py-1.5 text-[12px] text-zinc-600">
                            {s.startTime && <span className="mr-2 font-semibold">{fmtTime(s.startTime)}</span>}
                            {s.title}
                          </div>
                        ) : (
                          <div className={`rounded-xl border p-4 transition-all ${
                            isAward
                              ? 'border-yellow-400/25 bg-yellow-400/5 hover:border-yellow-400/40'
                              : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
                          }`}>
                            {isAward && (
                              <div className="mb-1.5 flex items-center gap-1">
                                <Star className="size-3 text-yellow-400" fill="currentColor" aria-hidden />
                                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-yellow-400">
                                  Award Presentation
                                </span>
                              </div>
                            )}
                            <p className={`font-bold ${isAward ? 'text-white' : 'text-zinc-200'}`}>{s.title}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-zinc-500">
                              {s.startTime && (
                                <span className="flex items-center gap-1">
                                  <Clock className="size-3" aria-hidden />
                                  {fmtTime(s.startTime)}{s.endTime ? ` – ${fmtTime(s.endTime)}` : ''}
                                </span>
                              )}
                              {s.location && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="size-3" aria-hidden />
                                  {s.location}
                                </span>
                              )}
                            </div>
                            {s.description?.trim() && (
                              <p className="mt-1 text-[12px] text-zinc-500 line-clamp-1">{s.description}</p>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
    </section>
  )
}
