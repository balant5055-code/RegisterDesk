'use client'

import { motion } from 'framer-motion'
import { Clock, MapPin, CalendarDays, Coffee } from 'lucide-react'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalScheduleProps {
  agenda: AgendaSession[]
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t?: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

function fmtDate(d: string) {
  if (!d) return d
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

const DAY_ACCENTS = [
  { dot: 'bg-violet-400', badge: 'bg-violet-500/20 text-violet-300 border-violet-500/30' },
  { dot: 'bg-rose-400',   badge: 'bg-rose-500/20   text-rose-300   border-rose-500/30'   },
  { dot: 'bg-amber-400',  badge: 'bg-amber-500/20  text-amber-300  border-amber-500/30'  },
  { dot: 'bg-teal-400',   badge: 'bg-teal-500/20   text-teal-300   border-teal-500/30'   },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalSchedule({ agenda }: CulturalScheduleProps) {
  if (!agenda.length) return null

  const groups = groupByDate(agenda)

  return (
    <section className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-10"
        >
          <div className="mb-2 flex items-center gap-2">
            <CalendarDays className="size-4 text-amber-400" aria-hidden />
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
              Programme
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Full Schedule
          </h2>
          <p className="mt-2 text-base text-white/40">
            The complete programme across all days.
          </p>
        </motion.div>

        <div className="space-y-10">
          {groups.map(([date, sessions], gi) => {
            const accent = DAY_ACCENTS[gi % DAY_ACCENTS.length]!
            return (
              <div key={date}>
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.35, delay: gi * 0.07 }}
                  className="mb-4 flex items-center gap-3"
                >
                  <span className={`rounded-full border px-4 py-1 text-[11px] font-bold uppercase tracking-[0.16em] ${accent.badge}`}>
                    {date === 'TBD' ? 'Schedule' : `Day ${gi + 1}`}
                  </span>
                  {date !== 'TBD' && (
                    <span className="text-sm text-white/30">{fmtDate(date)}</span>
                  )}
                </motion.div>

                <div className="relative space-y-0 pl-5 before:absolute before:inset-y-0 before:left-2 before:w-px before:bg-white/10">
                  {sessions.map((s, si) => (
                    <motion.div
                      key={s.id}
                      initial={{ opacity: 0, x: 10 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: gi * 0.05 + si * 0.03 }}
                      className={`relative py-3 ${s.isBreak ? 'opacity-40' : ''}`}
                    >
                      {/* Timeline dot */}
                      <div className={`absolute -left-[17px] mt-[7px] size-2 rounded-full ${s.isBreak ? 'bg-white/20' : accent.dot}`} aria-hidden />

                      {s.isBreak ? (
                        <div className="flex items-center gap-2 text-[12px] text-white/40">
                          <Coffee className="size-3.5" aria-hidden />
                          {s.startTime && <span>{fmtTime(s.startTime)}</span>}
                          <span>{s.title}</span>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-white/8 bg-gray-900 p-4 hover:border-white/15 transition-colors">
                          <p className="font-bold text-white">{s.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-white/30">
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
                            {s.track && (
                              <span className="text-white/25">{s.track}</span>
                            )}
                          </div>
                          {s.description?.trim() && (
                            <p className="mt-1.5 text-[12px] text-white/30 line-clamp-2">{s.description}</p>
                          )}
                        </div>
                      )}
                    </motion.div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
