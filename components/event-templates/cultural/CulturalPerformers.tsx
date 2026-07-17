'use client'

import { motion } from 'framer-motion'
import { Mic2, User } from 'lucide-react'
import { FaLinkedinIn, FaTwitter } from 'react-icons/fa'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalPerformersProps {
  performers: Speaker[]
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

const ROLE_COLORS = [
  'from-violet-500 to-purple-600',
  'from-rose-500 to-pink-600',
  'from-amber-500 to-orange-500',
  'from-teal-500 to-cyan-600',
  'from-blue-500 to-indigo-600',
  'from-emerald-500 to-green-600',
]

// ─── Sub-components ────────────────────────────────────────────────────────────

function LeadPerformerCard({ performer, gradient }: { performer: Speaker; gradient: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-3xl border border-white/10 bg-gray-950 p-6 sm:p-8"
    >
      {/* Ambient gradient */}
      <div className={`absolute -right-20 -top-20 size-60 rounded-full bg-gradient-to-br ${gradient} opacity-[0.08] blur-3xl`} />

      <div className="relative flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* Photo */}
        <div className="flex-shrink-0">
          {performer.photoUrl?.trim() ? (
            <div className="relative mx-auto size-28 sm:size-36">
              <div className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${gradient} opacity-70 blur-[2px]`} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={performer.photoUrl}
                alt={performer.name}
                className="relative size-28 rounded-2xl object-cover ring-2 ring-white/10 sm:size-36"
              />
            </div>
          ) : (
            <div className={`mx-auto flex size-28 items-center justify-center rounded-2xl bg-gradient-to-br ${gradient} sm:size-36`}>
              <User className="size-12 text-white/40" aria-hidden />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1">
          <div className="mb-2 flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full bg-gradient-to-r ${gradient} px-3 py-1 text-[10.5px] font-bold text-white`}>
              Headliner
            </span>
          </div>
          <h3 className="mb-1 text-[1.375rem] font-black text-white">{performer.name}</h3>
          {performer.title && (
            <p className="mb-1 text-[0.9375rem] font-semibold text-white/60">{performer.title}</p>
          )}
          {performer.company && (
            <p className="mb-3 text-[0.875rem] text-white/40">{performer.company}</p>
          )}
          {performer.bio?.trim() && (
            <p className="line-clamp-3 text-[0.875rem] leading-relaxed text-white/50">
              {performer.bio}
            </p>
          )}
          {(performer.social?.twitter || performer.social?.linkedin) && (
            <div className="mt-4 flex items-center gap-2">
              {performer.social?.twitter?.trim() && (
                <a
                  href={performer.social.twitter}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex size-7 items-center justify-center rounded-lg bg-white/10 text-white/60 transition-all hover:bg-white/20 hover:text-white"
                >
                  <FaTwitter className="size-3.5" aria-hidden />
                </a>
              )}
              {performer.social?.linkedin?.trim() && (
                <a
                  href={performer.social.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex size-7 items-center justify-center rounded-lg bg-white/10 text-white/60 transition-all hover:bg-white/20 hover:text-white"
                >
                  <FaLinkedinIn className="size-3.5" aria-hidden />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
}

function PerformerCard({ performer, gradient, delay }: { performer: Speaker; gradient: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className="group flex flex-col items-center rounded-2xl border border-white/10 bg-gray-900 p-5 text-center transition-all duration-200 hover:border-white/20"
    >
      {performer.photoUrl?.trim() ? (
        <div className="relative mb-4 size-20">
          <div className={`absolute inset-0 rounded-full bg-gradient-to-br ${gradient} opacity-60 blur-[1px]`} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={performer.photoUrl}
            alt={performer.name}
            className="relative size-20 rounded-full object-cover ring-2 ring-white/10"
          />
        </div>
      ) : (
        <div className={`mb-4 flex size-20 items-center justify-center rounded-full bg-gradient-to-br ${gradient}`}>
          <User className="size-8 text-white/40" aria-hidden />
        </div>
      )}

      <p className="mb-0.5 font-black text-white">{performer.name}</p>
      {performer.title && (
        <p className="text-[0.8125rem] font-medium text-white/50">{performer.title}</p>
      )}
      {performer.company && (
        <p className="mt-0.5 text-[11.5px] text-white/30">{performer.company}</p>
      )}
    </motion.div>
  )
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalPerformers({ performers }: CulturalPerformersProps) {
  if (!performers.length) return null

  const [lead, ...rest] = performers

  return (
    <section id="performers" className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mb-10"
        >
          <div className="mb-2 flex items-center gap-2">
            <Mic2 className="size-4 text-amber-400" aria-hidden />
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
              Performers
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2rem]">
            Featured Artists
          </h2>
          <p className="mt-2 text-base text-white/40">
            {performers.length} performing artist{performers.length !== 1 ? 's' : ''} at this festival.
          </p>
        </motion.div>

        {/* Lead performer */}
        {lead && (
          <div className="mb-6">
            <LeadPerformerCard performer={lead} gradient={ROLE_COLORS[0]!} />
          </div>
        )}

        {/* Supporting performers */}
        {rest.length > 0 && (
          <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${rest.length >= 4 ? 'lg:grid-cols-4' : ''}`}>
            {rest.map((p, i) => (
              <PerformerCard
                key={p.id}
                performer={p}
                gradient={ROLE_COLORS[(i + 1) % ROLE_COLORS.length]!}
                delay={i * 0.06}
              />
            ))}
          </div>
        )}

      </div>
    </section>
  )
}
