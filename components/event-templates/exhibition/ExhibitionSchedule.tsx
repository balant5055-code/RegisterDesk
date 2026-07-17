'use client'

import { motion } from 'framer-motion'
import { Clock, MapPin, Coffee, Star } from 'lucide-react'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface ExhibitionScheduleProps {
  agenda: AgendaSession[]
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
    weekday: 'short', day: 'numeric', month: 'long',
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

const isBreakSession = (s: AgendaSession) => s.isBreak

const isFeatured = (s: AgendaSession) =>
  /opening|ceremony|keynote|inauguration|closing/i.test(s.title)

// ─── Component ─────────────────────────────────────────────────────────────────

export function ExhibitionSchedule({ agenda }: ExhibitionScheduleProps) {
  if (!agenda.length) return null

  const groups = groupByDate(agenda)

  return (
    <section className="bg-gray-50 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Programme
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Event Schedule
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Opening ceremonies, product launches, and keynote demos.
          </p>
        </motion.div>

        <div className="space-y-10">
          {groups.map(([date, sessions], gi) => (
            <div key={date}>
              {/* Day label */}
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.35, delay: gi * 0.08 }}
                className="mb-4 flex items-center gap-3"
              >
                <span className="inline-flex items-center rounded-lg bg-teal-600 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white">
                  {date === 'TBD' ? 'Schedule' : `Day ${gi + 1}`}
                </span>
                {date !== 'TBD' && (
                  <span className="text-sm font-medium text-gray-400">{fmtDate(date)}</span>
                )}
              </motion.div>

              {/* Sessions */}
              <div className="relative space-y-2 pl-4 before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-gray-200">
                {sessions.map((s, si) => {
                  const featured = isFeatured(s)
                  const breakItem = isBreakSession(s)

                  return (
                    <motion.div
                      key={s.id}
                      initial={{ opacity: 0, x: 12 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.32, delay: gi * 0.06 + si * 0.04 }}
                    >
                      {breakItem ? (
                        /* Break row */
                        <div className="flex items-center gap-3 py-2">
                          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-100 ring-2 ring-gray-50">
                            <Coffee className="size-2.5 text-gray-400" aria-hidden />
                          </div>
                          <span className="text-[12px] text-gray-400">{s.startTime ? fmtTime(s.startTime) : ''}</span>
                          <span className="text-[12px] font-medium text-gray-400">{s.title}</span>
                        </div>
                      ) : featured ? (
                        /* Featured row — opening/ceremony */
                        <div className="flex gap-4 rounded-xl border border-teal-100 bg-teal-50/60 p-4">
                          <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-teal-500 ring-2 ring-teal-100">
                            <Star className="size-3 text-white" aria-hidden />
                          </div>
                          <div className="min-w-0">
                            <p className="mb-1 text-sm font-black text-gray-900">{s.title}</p>
                            <div className="flex flex-wrap items-center gap-3 text-[12px] text-gray-500">
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
                            {s.description && (
                              <p className="mt-1 text-[12px] text-gray-400">{s.description}</p>
                            )}
                          </div>
                        </div>
                      ) : (
                        /* Standard session row */
                        <div className="flex gap-3 rounded-xl bg-white p-3.5 border border-gray-100">
                          <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-100 ring-2 ring-white">
                            <div className="size-1.5 rounded-full bg-teal-500" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[0.875rem] font-semibold text-gray-800">{s.title}</p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2.5 text-[11.5px] text-gray-400">
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
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  )
}
