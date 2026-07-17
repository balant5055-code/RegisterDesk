'use client'

import { useRef, useState, useEffect } from 'react'
import { motion, useInView } from 'framer-motion'

interface Stat { value: number; suffix: string; label: string; sublabel: string }

function AnimatedCount({ target, started }: { target: number; started: boolean }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!started) return
    let raf: number
    let t0: number | null = null
    const dur = 1600
    const tick = (ts: number) => {
      t0 ??= ts
      const p = Math.min((ts - t0) / dur, 1)
      setN(Math.round((1 - Math.pow(1 - p, 3)) * target))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [started, target])
  return <>{n.toLocaleString('en-IN')}</>
}

function firstNum(text: string): { value: number; suffix: string } | null {
  const m = text.match(/(\d[\d,]*)\s*(million|crore|lakh|tonnes|tons|ton|kg|KG|km|KM|%)?/i)
  if (!m) return null
  const v = parseInt(m[1]!.replace(/,/g, ''), 10)
  if (isNaN(v) || v <= 0) return null
  return { value: v, suffix: m[2] ? ` ${m[2].toLowerCase()}` : '' }
}

export function CommunityImpactNumbers({
  totalAttendees, showAttendeeCount,
  impactGoal, causeInfo, campaignInfo,
}: {
  totalAttendees:    number
  showAttendeeCount: boolean
  impactGoal:        string
  causeInfo:         string
  campaignInfo:      string
}) {
  const ref    = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.3 })

  const stats: Stat[] = []

  if (showAttendeeCount && totalAttendees > 0)
    stats.push({
      value: totalAttendees, suffix: '+',
      label: 'Joined So Far',
      sublabel: 'and still growing',
    })

  if (impactGoal.trim()) {
    const p = firstNum(impactGoal)
    if (p) stats.push({ value: p.value, suffix: p.suffix, label: 'Our Impact Goal', sublabel: 'for this campaign' })
  }

  if (causeInfo.trim()) {
    const p = firstNum(causeInfo)
    if (p && p.value !== totalAttendees)
      stats.push({ value: p.value, suffix: p.suffix, label: 'People Affected', sublabel: 'by this issue' })
  }

  if (campaignInfo.trim() && stats.length < 4) {
    const p = firstNum(campaignInfo)
    if (p) stats.push({ value: p.value, suffix: p.suffix, label: 'Campaign Reach', sublabel: 'in awareness' })
  }

  if (stats.length === 0) return null

  return (
    <section className="bg-white py-10 sm:py-12">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5 }}
          className="mb-7"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            Our Impact
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            The change we're creating together
          </h2>
        </motion.div>

        {/* Stats grid — bordered, editorial */}
        <div
          ref={ref}
          className={`grid divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 sm:divide-x sm:divide-y-0 ${
            stats.length <= 2
              ? 'sm:grid-cols-2'
              : stats.length === 3
              ? 'sm:grid-cols-3'
              : 'sm:grid-cols-2 lg:grid-cols-4'
          }`}
        >
          {stats.map((stat, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ delay: i * 0.08, duration: 0.45 }}
              className="px-6 py-6 sm:px-7"
            >
              <p className="text-[clamp(1.625rem,3.5vw,2.5rem)] font-black leading-none tabular-nums text-gray-900">
                <AnimatedCount target={stat.value} started={inView} />
                <span className="ml-0.5 text-[0.45em] font-bold text-gray-400">{stat.suffix}</span>
              </p>
              <p className="mt-2 text-[0.8125rem] font-bold text-gray-700">{stat.label}</p>
              <p className="mt-0.5 text-[0.75rem] text-gray-400">{stat.sublabel}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
