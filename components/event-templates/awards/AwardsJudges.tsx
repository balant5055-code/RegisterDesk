'use client'

import { motion } from 'framer-motion'
import { User, ShieldCheck } from 'lucide-react'
import { FaLinkedinIn, FaTwitter } from 'react-icons/fa'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsJudgesProps {
  judges: Speaker[]
}

// ─── Sub-component ─────────────────────────────────────────────────────────────

function JudgeCard({ judge, isLead, delay }: { judge: Speaker; isLead: boolean; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`relative overflow-hidden rounded-2xl border bg-zinc-900 transition-all duration-200 ${
        isLead
          ? 'border-yellow-400/30 shadow-[0_0_40px_-10px_rgba(234,179,8,0.15)]'
          : 'border-zinc-800 hover:border-zinc-700'
      }`}
    >
      {isLead && (
        <div className="h-[2px] w-full bg-gradient-to-r from-yellow-400/0 via-yellow-400 to-yellow-400/0" />
      )}

      <div className={`flex flex-col items-center p-6 text-center ${isLead ? 'p-7' : ''}`}>
        {/* Photo */}
        {judge.photoUrl?.trim() ? (
          <div className={`relative mb-4 overflow-hidden rounded-full ring-2 ${
            isLead ? 'ring-yellow-400/40' : 'ring-zinc-700'
          } ${isLead ? 'size-24' : 'size-20'}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={judge.photoUrl} alt={judge.name} className="h-full w-full object-cover" />
          </div>
        ) : (
          <div className={`mb-4 flex items-center justify-center rounded-full border ${
            isLead ? 'border-yellow-400/30 bg-yellow-400/8 size-24' : 'border-zinc-700 bg-zinc-800 size-20'
          }`}>
            <User className={`${isLead ? 'size-10 text-yellow-400/40' : 'size-8 text-zinc-600'}`} aria-hidden />
          </div>
        )}

        {/* Jury badge on lead */}
        {isLead && (
          <div className="mb-3 flex items-center gap-1.5 rounded-full border border-yellow-400/20 bg-yellow-400/8 px-3 py-1">
            <ShieldCheck className="size-3 text-yellow-400" aria-hidden />
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-yellow-400">Jury Chair</span>
          </div>
        )}

        <h3 className={`font-black text-white ${isLead ? 'text-[1.125rem]' : 'text-[0.9375rem]'}`}>
          {judge.name}
        </h3>
        {judge.title?.trim() && (
          <p className={`mt-0.5 font-semibold ${isLead ? 'text-[0.9375rem] text-zinc-300' : 'text-[0.8125rem] text-zinc-400'}`}>
            {judge.title}
          </p>
        )}
        {judge.company?.trim() && (
          <p className={`text-zinc-500 ${isLead ? 'mt-0.5 text-[0.875rem]' : 'mt-0.5 text-[0.8125rem]'}`}>
            {judge.company}
          </p>
        )}

        {isLead && judge.bio?.trim() && (
          <p className="mt-3 line-clamp-2 text-[0.8125rem] leading-relaxed text-zinc-400">
            {judge.bio}
          </p>
        )}

        {/* Social */}
        {(judge.social?.twitter || judge.social?.linkedin) && (
          <div className="mt-4 flex items-center gap-2">
            {judge.social?.twitter?.trim() && (
              <a href={judge.social.twitter} target="_blank" rel="noopener noreferrer"
                className="flex size-7 items-center justify-center rounded-lg bg-zinc-800 text-zinc-500 transition-all hover:bg-zinc-700 hover:text-yellow-400">
                <FaTwitter className="size-3.5" aria-hidden />
              </a>
            )}
            {judge.social?.linkedin?.trim() && (
              <a href={judge.social.linkedin} target="_blank" rel="noopener noreferrer"
                className="flex size-7 items-center justify-center rounded-lg bg-zinc-800 text-zinc-500 transition-all hover:bg-zinc-700 hover:text-yellow-400">
                <FaLinkedinIn className="size-3.5" aria-hidden />
              </a>
            )}
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsJudges({ judges }: AwardsJudgesProps) {
  if (!judges.length) return null

  const [lead, ...rest] = judges
  const hasRest = rest.length > 0

  return (
    <section className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

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
              Judges Panel
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Our Expert Jury
          </h2>
          <p className="mt-3 max-w-xl text-base text-zinc-400">
            {judges.length} distinguished expert{judges.length !== 1 ? 's' : ''} evaluating nominations.
          </p>
        </motion.div>

        {/* Lead judge */}
        {lead && (
          <div className={`mb-6 ${hasRest ? 'lg:grid lg:grid-cols-[300px_1fr] lg:gap-6' : 'max-w-xs'}`}>
            <JudgeCard judge={lead} isLead delay={0} />

            {/* Rest grid alongside lead on large screens */}
            {hasRest && (
              <div className={`mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mt-0 ${
                rest.length >= 4 ? 'xl:grid-cols-4' : ''
              }`}>
                {rest.map((j, i) => (
                  <JudgeCard key={j.id} judge={j} isLead={false} delay={i * 0.06} />
                ))}
              </div>
            )}
          </div>
        )}

      </div>
    </section>
  )
}
