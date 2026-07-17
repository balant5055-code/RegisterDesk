'use client'

import { motion } from 'framer-motion'
import { Clock, MapPin, Music } from 'lucide-react'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalLineupProps {
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
    weekday: 'long', day: 'numeric', month: 'long',
  })
}

function groupByTrackThenDate(sessions: AgendaSession[]) {
  // Try track-based (stage-based) grouping first
  const hasTracks = sessions.some(s => s.track?.trim())
  if (hasTracks) {
    const map = new Map<string, AgendaSession[]>()
    for (const s of sessions) {
      const key = s.track?.trim() || 'Main Stage'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return { mode: 'track' as const, groups: Array.from(map.entries()) }
  }
  // Fall back to date-based
  const map = new Map<string, AgendaSession[]>()
  for (const s of sessions) {
    const key = s.date ?? 'TBD'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return { mode: 'date' as const, groups: Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)) }
}

const STAGE_COLORS = [
  { bg: 'bg-violet-500/20', fg: 'text-violet-300', dot: 'bg-violet-400' },
  { bg: 'bg-rose-500/20',   fg: 'text-rose-300',   dot: 'bg-rose-400'   },
  { bg: 'bg-amber-500/20',  fg: 'text-amber-300',  dot: 'bg-amber-400'  },
  { bg: 'bg-teal-500/20',   fg: 'text-teal-300',   dot: 'bg-teal-400'   },
  { bg: 'bg-blue-500/20',   fg: 'text-blue-300',   dot: 'bg-blue-400'   },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalLineup({ agenda }: CulturalLineupProps) {
  if (!agenda.length) return null

  const active   = agenda.filter(s => !s.isBreak)
  if (!active.length) return null

  const { mode, groups } = groupByTrackThenDate(active)

  return (
    <section id="lineup" className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-10"
        >
          <div className="mb-2 flex items-center gap-2">
            <Music className="size-4 text-amber-400" aria-hidden />
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
              Programme
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            {mode === 'track' ? 'Stage Lineup' : 'Event Lineup'}
          </h2>
        </motion.div>

        <div className={`grid gap-6 ${groups.length >= 2 ? 'md:grid-cols-2' : ''}`}>
          {groups.map(([label, sessions], gi) => {
            const style = STAGE_COLORS[gi % STAGE_COLORS.length]!
            const displayLabel = mode === 'date' && label !== 'TBD' ? fmtDate(label) : label
            return (
              <motion.div
                key={label}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, delay: gi * 0.08 }}
                className="overflow-hidden rounded-2xl border border-white/10 bg-gray-900"
              >
                {/* Stage header */}
                <div className={`flex items-center gap-3 px-5 py-3.5 ${style.bg}`}>
                  <div className={`size-2 rounded-full ${style.dot}`} aria-hidden />
                  <span className={`text-[11px] font-bold uppercase tracking-[0.18em] ${style.fg}`}>
                    {displayLabel}
                  </span>
                </div>

                {/* Sessions */}
                <div className="divide-y divide-white/5">
                  {sessions.map((s, si) => (
                    <motion.div
                      key={s.id}
                      initial={{ opacity: 0, x: 8 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.3, delay: gi * 0.06 + si * 0.04 }}
                      className="flex items-start gap-4 px-5 py-3.5"
                    >
                      {/* Time */}
                      <div className="mt-0.5 min-w-[70px] text-[12px] font-semibold text-white/40">
                        {s.startTime ? fmtTime(s.startTime) : '—'}
                      </div>

                      {/* Session info */}
                      <div className="flex-1">
                        <p className="font-semibold text-white/90 leading-snug">{s.title}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-white/30">
                          {s.endTime && (
                            <span className="flex items-center gap-1">
                              <Clock className="size-3" aria-hidden />
                              ends {fmtTime(s.endTime)}
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
                          <p className="mt-1 text-[11.5px] leading-relaxed text-white/30 line-clamp-1">
                            {s.description}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
