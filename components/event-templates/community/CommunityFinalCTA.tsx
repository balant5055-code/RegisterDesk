'use client'

import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

export function CommunityFinalCTA({
  bannerUrl, isFreeEvent, registrationOpen, title,
}: {
  bannerUrl:        string
  isFreeEvent:      boolean
  registrationOpen: boolean
  title:            string
}) {
  if (!registrationOpen) return null

  return (
    <section className="relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0" aria-hidden>
        {bannerUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bannerUrl} alt="" className="h-full w-full object-cover object-center" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-cyan-900 to-emerald-900" />
        )}
        <div className="absolute inset-0 bg-black/78" />
      </div>

      <div className="relative py-28 text-center sm:py-36">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto max-w-2xl px-5"
        >
          <p className="mb-4 text-[10px] font-bold uppercase tracking-[0.25em] text-emerald-400">
            Be Part of the Change
          </p>
          <h2 className="mb-5 text-[clamp(2rem,5vw,3.5rem)] font-black leading-[1.08] text-white">
            {title}
          </h2>
          <p className="mb-10 text-[1.0625rem] text-white/55">
            Join the movement — because every action, every volunteer, every voice counts.
          </p>
          <a
            href="#tickets"
            className="group inline-flex items-center gap-2.5 rounded-full bg-white px-10 py-4 text-[1rem] font-bold text-gray-900 shadow-[0_10px_40px_rgba(255,255,255,0.18)] transition-all hover:scale-[1.03] hover:shadow-[0_10px_50px_rgba(255,255,255,0.28)] active:scale-[0.98]"
          >
            {isFreeEvent ? 'Join The Movement' : 'Register Now'}
            <ArrowRight className="size-5 transition-transform group-hover:translate-x-1" aria-hidden />
          </a>
        </motion.div>
      </div>
    </section>
  )
}
