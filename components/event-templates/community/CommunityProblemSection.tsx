'use client'

import { motion } from 'framer-motion'

function firstSentence(text: string, max = 120): string {
  const m = text.match(/^[^.!?\n]{15,}[.!?]/)
  const s = m ? m[0] : text.slice(0, max)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function CommunityProblemSection({
  causeInfo, campaignInfo, impactGoal, volunteerInstructions,
}: {
  causeInfo:             string
  campaignInfo:          string
  impactGoal:            string
  volunteerInstructions: string
}) {
  const hasCause    = causeInfo.trim().length > 0
  const hasCampaign = campaignInfo.trim().length > 0
  const hasGoal     = impactGoal.trim().length > 0
  const hasVolunteer = volunteerInstructions.trim().length > 0

  if (!hasCause && !hasCampaign && !hasGoal && !hasVolunteer) return null

  const pullQuote = hasGoal
    ? impactGoal.trim()
    : hasCause
    ? firstSentence(causeInfo)
    : ''

  const bodyLeft  = hasCause && hasCampaign ? causeInfo : hasCause ? causeInfo : ''
  const bodyRight = hasCampaign ? campaignInfo : ''

  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        {/* Section rule + label */}
        <div className="mb-10 flex items-center gap-4">
          <div className="h-px flex-1 bg-slate-200" aria-hidden />
          <p className="shrink-0 text-[10px] font-bold uppercase tracking-[0.25em] text-slate-400">
            The Challenge We Face
          </p>
          <div className="h-px flex-1 bg-slate-200" aria-hidden />
        </div>

        {/* Pull quote */}
        {pullQuote && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="mb-10"
          >
            <p className="mx-auto max-w-3xl text-center text-[clamp(1.25rem,2.5vw,1.875rem)] font-black leading-[1.25] tracking-tight text-gray-900">
              {pullQuote}
            </p>
          </motion.div>
        )}

        {/* Body text */}
        {(bodyLeft || bodyRight) && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: 0.55, delay: 0.1 }}
            className={`grid gap-6 ${bodyLeft && bodyRight ? 'lg:grid-cols-2 lg:gap-10' : ''}`}
          >
            {bodyLeft && (
              <p className="text-[0.9375rem] leading-[1.8] text-gray-600">{bodyLeft}</p>
            )}
            {bodyRight && (
              <p className="text-[0.9375rem] leading-[1.8] text-gray-500">{bodyRight}</p>
            )}
          </motion.div>
        )}

        {/* Volunteer block */}
        {hasVolunteer && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="mt-8 rounded-2xl bg-white p-5 ring-1 ring-black/5 sm:p-6"
          >
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-rose-500">
              How to Volunteer
            </p>
            <p className="text-[0.9375rem] leading-relaxed text-gray-600">
              {volunteerInstructions}
            </p>
          </motion.div>
        )}
      </div>
    </section>
  )
}
