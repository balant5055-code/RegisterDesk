'use client'

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Clock } from 'lucide-react'
import type { AgendaSession } from '@/components/wizard/eventDetailsConfig'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

// ─── Module structure ─────────────────────────────────────────────────────────

interface Module {
  name:     string
  sessions: AgendaSession[]
}

function buildModules(sessions: AgendaSession[]): Module[] {
  const sorted = [...sessions]
    .filter(s => s.title?.trim())
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))

  const trackMap = new Map<string, AgendaSession[]>()
  const noTrack: AgendaSession[] = []

  for (const s of sorted) {
    if (s.track?.trim()) {
      const arr = trackMap.get(s.track) ?? []
      arr.push(s)
      trackMap.set(s.track, arr)
    } else {
      noTrack.push(s)
    }
  }

  const modules: Module[] = []
  let idx = 1

  if (trackMap.size > 0) {
    for (const [track, sArr] of trackMap.entries()) {
      modules.push({ name: track || `Module ${idx++}`, sessions: sArr })
    }
  } else if (noTrack.length > 0) {
    // No tracks: put all in one module or group by date
    const dates = [...new Set(noTrack.map(s => s.date))].sort()
    if (dates.length > 1) {
      for (const date of dates) {
        const daySessions = noTrack.filter(s => s.date === date)
        modules.push({ name: `Day ${idx++}`, sessions: daySessions })
      }
    } else {
      modules.push({ name: 'Course Content', sessions: noTrack })
    }
  }

  return modules
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopCurriculumProps {
  agenda: AgendaSession[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopCurriculum({ agenda }: WorkshopCurriculumProps) {
  const modules = useMemo(() => buildModules(agenda), [agenda])
  const [openIdx, setOpenIdx] = useState<number | null>(0)

  const totalSessions = modules.reduce((n, m) => n + m.sessions.filter(s => !s.isBreak).length, 0)

  if (!modules.length) return null

  return (
    <section id="curriculum" className="bg-gray-50 py-12 sm:py-16">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
            Curriculum
          </p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Course Modules
          </h2>
          <p className="mt-1.5 text-sm text-gray-500">
            {modules.length} module{modules.length !== 1 ? 's' : ''} · {totalSessions} session{totalSessions !== 1 ? 's' : ''}
          </p>
        </motion.div>

        {/* Module accordion */}
        <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
          {modules.map((mod, mIdx) => {
            const isOpen = openIdx === mIdx
            const sessionCount = mod.sessions.filter(s => !s.isBreak).length

            return (
              <motion.div
                key={mIdx}
                initial={{ opacity: 0, y: 8 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.35, delay: mIdx * 0.05 }}
                className={mIdx < modules.length - 1 ? 'border-b border-gray-100' : ''}
              >
                {/* Module header */}
                <button
                  type="button"
                  onClick={() => setOpenIdx(isOpen ? null : mIdx)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-50 sm:px-6"
                  aria-expanded={isOpen}
                >
                  {/* Module number */}
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50">
                    <span className="text-[11.5px] font-black text-indigo-600">
                      {String(mIdx + 1).padStart(2, '0')}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-gray-900">{mod.name}</p>
                    <p className="text-[12px] text-gray-400">
                      {sessionCount} session{sessionCount !== 1 ? 's' : ''}
                    </p>
                  </div>

                  <motion.div
                    animate={{ rotate: isOpen ? 180 : 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-100"
                  >
                    <ChevronDown className="size-3.5 text-gray-500" aria-hidden />
                  </motion.div>
                </button>

                {/* Sessions */}
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.25, 0, 0, 1] }}
                      className="overflow-hidden border-t border-gray-50"
                    >
                      <div className="px-5 py-3 sm:px-6">
                        {mod.sessions.map((session, sIdx) => {
                          if (session.isBreak) {
                            return (
                              <div key={session.id} className="flex items-center gap-3 py-2 text-[12px] text-gray-400">
                                <div className="h-px flex-1 border-t border-dashed border-gray-200" />
                                <span>{session.title}</span>
                                <div className="h-px flex-1 border-t border-dashed border-gray-200" />
                              </div>
                            )
                          }
                          return (
                            <div
                              key={session.id}
                              className={`flex items-start gap-3 py-2.5 ${
                                sIdx < mod.sessions.length - 1 ? 'border-b border-gray-50' : ''
                              }`}
                            >
                              <div className="mt-1 size-1.5 shrink-0 rounded-full bg-blue-300" />
                              <div className="flex-1 min-w-0">
                                <p className="text-[0.875rem] font-semibold text-gray-800">
                                  {session.title}
                                </p>
                                {session.description?.trim() && (
                                  <p className="mt-0.5 text-[12px] leading-relaxed text-gray-400 line-clamp-2">
                                    {session.description}
                                  </p>
                                )}
                              </div>
                              {session.startTime && (
                                <div className="flex shrink-0 items-center gap-1 text-[11px] text-gray-300">
                                  <Clock className="size-3" aria-hidden />
                                  {fmtTime(session.startTime)}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )
          })}
        </div>

      </div>
    </section>
  )
}
