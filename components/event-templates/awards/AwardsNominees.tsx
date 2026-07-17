'use client'

import { motion } from 'framer-motion'
import { ClipboardList, CheckCircle2, ChevronRight } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsNomineesProps {
  nominationRules?: string
  judgingProcess?:  string
}

// ─── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = [
  {
    num:   '01',
    title: 'Submit Nomination',
    desc:  'Nominate yourself, your organisation, or a deserving candidate before the deadline.',
  },
  {
    num:   '02',
    title: 'Initial Screening',
    desc:  'Submissions are reviewed by the organising team against eligibility and completeness criteria.',
  },
  {
    num:   '03',
    title: 'Expert Evaluation',
    desc:  'A panel of independent judges evaluates shortlisted nominees against defined scoring rubrics.',
  },
  {
    num:   '04',
    title: 'Winners Announced',
    desc:  'Winners are revealed live at the award ceremony. Finalists are notified in advance.',
  },
]

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsNominees({ nominationRules, judgingProcess }: AwardsNomineesProps) {
  const hasRules   = !!nominationRules?.trim()
  const hasProcess = !!judgingProcess?.trim()

  return (
    <section className="bg-zinc-900 py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="mb-12"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Nominees
            </p>
          </div>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-[2.25rem]">
            Nomination &amp; Judging Process
          </h2>
          <p className="mt-3 max-w-xl text-base text-zinc-400">
            A rigorous, transparent process to identify and celebrate true excellence.
          </p>
        </motion.div>

        {/* Steps */}
        <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.08 }}
              className="relative"
            >
              {/* Connector line */}
              {i < STEPS.length - 1 && (
                <div className="absolute left-full top-6 hidden w-full max-w-[calc(100%-24px)] lg:block">
                  <div className="ml-4 h-px bg-gradient-to-r from-yellow-400/20 to-yellow-400/5" />
                  <ChevronRight className="absolute right-0 top-1/2 size-3 -translate-y-1/2 text-yellow-400/20" aria-hidden />
                </div>
              )}

              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
                <p className="mb-3 text-[2rem] font-black leading-none text-yellow-400/20 tracking-tight">
                  {step.num}
                </p>
                <h3 className="mb-2 text-[0.9375rem] font-black text-white">{step.title}</h3>
                <p className="text-[0.8125rem] leading-relaxed text-zinc-400">{step.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Rules & process detail */}
        {(hasRules || hasProcess) && (
          <div className="grid gap-4 md:grid-cols-2">
            {hasRules && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45 }}
                className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg border border-yellow-400/20 bg-yellow-400/8">
                    <ClipboardList className="size-4 text-yellow-400" aria-hidden />
                  </div>
                  <h3 className="font-black text-white">Nomination Rules</h3>
                </div>
                <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-zinc-400">
                  {nominationRules}
                </p>
              </motion.div>
            )}
            {hasProcess && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.45, delay: 0.06 }}
                className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6"
              >
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg border border-yellow-400/20 bg-yellow-400/8">
                    <CheckCircle2 className="size-4 text-yellow-400" aria-hidden />
                  </div>
                  <h3 className="font-black text-white">Judging Process</h3>
                </div>
                <p className="whitespace-pre-line text-[0.875rem] leading-relaxed text-zinc-400">
                  {judgingProcess}
                </p>
              </motion.div>
            )}
          </div>
        )}

      </div>
    </section>
  )
}
