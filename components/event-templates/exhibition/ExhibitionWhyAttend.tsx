'use client'

import { motion } from 'framer-motion'
import { Search, Handshake, TrendingUp, Network } from 'lucide-react'

const BENEFITS = [
  {
    Icon:  Search,
    title: 'Discover Products & Solutions',
    desc:  'Explore hundreds of product launches, live demos, and industry innovations — all under one roof.',
    bg:    'bg-teal-50',
    fg:    'text-teal-600',
  },
  {
    Icon:  Handshake,
    title: 'Meet Verified Suppliers',
    desc:  'Connect directly with manufacturers, distributors, and solution providers. Evaluate, compare, and source on the spot.',
    bg:    'bg-blue-50',
    fg:    'text-blue-600',
  },
  {
    Icon:  Network,
    title: 'Network with Industry Peers',
    desc:  'Engage with decision-makers, procurement heads, and industry experts across dedicated networking zones.',
    bg:    'bg-violet-50',
    fg:    'text-violet-600',
  },
  {
    Icon:  TrendingUp,
    title: 'Stay Ahead of Trends',
    desc:  'Attend keynotes, panel discussions, and product showcases to stay informed about the latest industry directions.',
    bg:    'bg-emerald-50',
    fg:    'text-emerald-600',
  },
]

export function ExhibitionWhyAttend() {
  return (
    <section className="bg-white py-14 sm:py-18">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-teal-600">
            Why Visit
          </p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
            Why You Should Attend
          </h2>
          <p className="mt-2 text-base text-gray-500">
            Whether you are a buyer, investor, or industry professional — this expo delivers real business value.
          </p>
        </motion.div>

        <div className="grid gap-5 sm:grid-cols-2">
          {BENEFITS.map(({ Icon, title, desc, bg, fg }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.38, delay: i * 0.08, ease: [0.25, 0, 0, 1] }}
              className="flex gap-5 rounded-2xl border border-gray-100 bg-gray-50 p-6"
            >
              <div className={`flex size-11 shrink-0 items-center justify-center rounded-2xl ${bg}`}>
                <Icon className={`size-5 ${fg}`} aria-hidden />
              </div>
              <div>
                <p className="mb-1 text-[1rem] font-bold text-gray-900">{title}</p>
                <p className="text-[0.875rem] leading-relaxed text-gray-500">{desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

      </div>
    </section>
  )
}
