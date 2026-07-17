'use client'

import { motion } from 'framer-motion'
import { Briefcase, TrendingUp, Award } from 'lucide-react'

const PERSONAS = [
  {
    Icon: Briefcase,
    title: 'Founders & CEOs',
    description: 'Connect with builders and company leaders who are scaling their ventures and shaping their industries from the ground up.',
    tags: ['Early Stage', 'Growth Stage', 'Bootstrapped', 'VC-backed'],
    bg: 'bg-violet-50',
    fg: 'text-violet-600',
  },
  {
    Icon: TrendingUp,
    title: 'Investors & VCs',
    description: 'Meet active angel investors, venture capitalists, and fund managers actively deploying capital and seeking the next breakout opportunity.',
    tags: ['Angel Investors', 'Seed VCs', 'Series A/B', 'Family Offices'],
    bg: 'bg-sky-50',
    fg: 'text-sky-600',
  },
  {
    Icon: Award,
    title: 'Industry Leaders',
    description: 'Learn directly from C-suite executives, domain experts, and thought leaders who are driving measurable change across their sectors.',
    tags: ['CXOs', 'VPs & Directors', 'Senior Advisors', 'Analysts'],
    bg: 'bg-emerald-50',
    fg: 'text-emerald-600',
  },
]

export function ConferenceNetworking() {
  return (
    <section className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-12"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">
            Networking
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
              Who Will You Meet?
            </h2>
            <p className="text-base text-gray-500">
              Build connections that outlast the event.
            </p>
          </div>
        </motion.div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PERSONAS.map(({ Icon, title, description, tags, bg, fg }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.05 }}
              transition={{ duration: 0.45, delay: i * 0.08, ease: [0.25, 0, 0, 1] }}
              className="rounded-2xl border border-gray-100 bg-white p-6 transition-all duration-200 hover:border-gray-200 hover:shadow-[0_8px_32px_-6px_rgba(0,0,0,0.09)]"
            >
              <div className={`mb-4 flex size-11 items-center justify-center rounded-xl ${bg}`}>
                <Icon className={`size-5 ${fg}`} aria-hidden />
              </div>

              <h3 className="mb-2 text-[1rem] font-bold text-gray-950">{title}</h3>
              <p className="mb-5 text-[0.8125rem] leading-relaxed text-gray-500">{description}</p>

              <div className="flex flex-wrap gap-1.5">
                {tags.map(tag => (
                  <span
                    key={tag}
                    className="rounded-full bg-gray-50 px-2.5 py-1 text-[11px] font-semibold text-gray-500 ring-1 ring-gray-100"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
