'use client'

import { motion } from 'framer-motion'
import { CheckCircle2, AlertCircle } from 'lucide-react'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopLearningProps {
  learningOutcomes: string[]
  prerequisites?:   string
  materialsIncluded?: string
  softwareRequired?:  string
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopLearning({
  learningOutcomes,
  prerequisites,
  materialsIncluded,
  softwareRequired,
}: WorkshopLearningProps) {
  const outcomes = learningOutcomes.filter(o => o?.trim())

  const hasContent = outcomes.length > 0 || prerequisites?.trim() || softwareRequired?.trim()
  if (!hasContent) return null

  return (
    <section id="learning" className="bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        <div className="grid gap-10 lg:grid-cols-[1fr_320px]">

          {/* Learning outcomes */}
          {outcomes.length > 0 && (
            <div>
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.1 }}
                transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
                className="mb-6"
              >
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
                  Learning Outcomes
                </p>
                <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
                  What You&apos;ll Learn
                </h2>
                <p className="mt-1.5 text-sm text-gray-500">
                  By the end of this workshop, you will be able to:
                </p>
              </motion.div>

              <div className="grid gap-2.5 sm:grid-cols-2">
                {outcomes.map((outcome, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -8 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.35, delay: Math.min(i, 8) * 0.04 }}
                    className="flex items-start gap-2.5 rounded-xl border border-gray-100 bg-gray-50 p-3.5"
                  >
                    <CheckCircle2 className="mt-[1px] size-4 shrink-0 text-blue-500" aria-hidden />
                    <span className="text-[0.875rem] leading-snug text-gray-700">{outcome}</span>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* Side: Prerequisites + Materials */}
          <div className="flex flex-col gap-5">

            {prerequisites?.trim() && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4 }}
                className="rounded-xl border border-amber-100 bg-amber-50 p-5"
              >
                <div className="mb-2 flex items-center gap-2">
                  <AlertCircle className="size-4 text-amber-600" aria-hidden />
                  <h3 className="text-[0.875rem] font-bold text-amber-900">Prerequisites</h3>
                </div>
                <p className="whitespace-pre-line text-[0.8125rem] leading-relaxed text-amber-800">
                  {prerequisites}
                </p>
              </motion.div>
            )}

            {(materialsIncluded?.trim() || softwareRequired?.trim()) && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: 0.05 }}
                className="rounded-xl border border-blue-100 bg-blue-50 p-5"
              >
                <h3 className="mb-3 text-[0.875rem] font-bold text-blue-900">
                  What&apos;s Included
                </h3>
                {materialsIncluded?.trim() && (
                  <div className="mb-3">
                    <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-blue-500">
                      Materials
                    </p>
                    <p className="whitespace-pre-line text-[0.8125rem] leading-relaxed text-blue-800">
                      {materialsIncluded}
                    </p>
                  </div>
                )}
                {softwareRequired?.trim() && (
                  <div>
                    <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-blue-500">
                      Software / Tools
                    </p>
                    <p className="whitespace-pre-line text-[0.8125rem] leading-relaxed text-blue-800">
                      {softwareRequired}
                    </p>
                  </div>
                )}
              </motion.div>
            )}

          </div>

        </div>
      </div>
    </section>
  )
}
