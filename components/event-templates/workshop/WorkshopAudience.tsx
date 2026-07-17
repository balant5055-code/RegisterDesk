'use client'

import { motion } from 'framer-motion'
import { GraduationCap, Code2, Briefcase, Rocket, Users } from 'lucide-react'

// ─── Default audience personas ─────────────────────────────────────────────────

const DEFAULT_PERSONAS = [
  {
    Icon:  GraduationCap,
    bg:    'bg-violet-50',
    fg:    'text-violet-600',
    title: 'Students',
    desc:  'College students and recent graduates building foundational skills.',
  },
  {
    Icon:  Code2,
    bg:    'bg-blue-50',
    fg:    'text-blue-600',
    title: 'Developers',
    desc:  'Working professionals looking to upskill or pivot to a new technology.',
  },
  {
    Icon:  Briefcase,
    bg:    'bg-teal-50',
    fg:    'text-teal-600',
    title: 'Professionals',
    desc:  'Experienced professionals adding new tools to their skillset.',
  },
  {
    Icon:  Rocket,
    bg:    'bg-orange-50',
    fg:    'text-orange-600',
    title: 'Founders',
    desc:  'Entrepreneurs and business owners who want hands-on technical knowledge.',
  },
]

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopAudienceProps {
  prerequisites?: string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopAudience({ prerequisites }: WorkshopAudienceProps) {
  return (
    <section className="bg-gray-50 py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
            Audience
          </p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Who Should Attend
          </h2>
          <p className="mt-1.5 text-sm text-gray-500">
            This workshop is designed for motivated learners at every stage.
          </p>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {DEFAULT_PERSONAS.map(({ Icon, bg, fg, title, desc }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.38, delay: i * 0.07 }}
              className="rounded-xl border border-gray-100 bg-white p-4"
            >
              <div className={`mb-3 flex size-9 items-center justify-center rounded-xl ${bg}`}>
                <Icon className={`size-4.5 ${fg}`} aria-hidden />
              </div>
              <p className="mb-1 font-bold text-gray-900">{title}</p>
              <p className="text-[12.5px] leading-relaxed text-gray-500">{desc}</p>
            </motion.div>
          ))}
        </div>

        {/* Prerequisites note */}
        {prerequisites?.trim() && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.38, delay: 0.2 }}
            className="mt-5 flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4"
          >
            <Users className="mt-0.5 size-4 shrink-0 text-gray-400" aria-hidden />
            <div>
              <p className="text-[13px] font-semibold text-gray-700">Prerequisites</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-gray-500">{prerequisites}</p>
            </div>
          </motion.div>
        )}

      </div>
    </section>
  )
}
