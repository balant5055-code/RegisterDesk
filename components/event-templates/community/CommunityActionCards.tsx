'use client'

import { motion } from 'framer-motion'
import { ArrowRight, Heart, Megaphone, Building2, CalendarCheck } from 'lucide-react'
import type { CommunityDetails, OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import type { PassPublic } from '@/components/event-templates/types'

interface Path {
  icon:  React.FC<{ className?: string }>
  label: string
  title: string
  body:  string
  cta:   string
  href?: string
}

export function CommunityActionCards({
  typeDetails, organizer, isFreeEvent, registrationOpen, passes,
}: {
  typeDetails:      Record<string, unknown> | null
  organizer?:       OrganizerInfo
  isFreeEvent:      boolean
  registrationOpen: boolean
  passes:           PassPublic[]
}) {
  const td = typeDetails as CommunityDetails | null
  const activePasses = passes.filter(p => p.status !== 'inactive')

  const paths: Path[] = []

  if (registrationOpen && activePasses.length > 0) {
    paths.push({
      icon:  CalendarCheck,
      label: 'Attend',
      title: isFreeEvent ? 'Show Up In Person' : 'Secure Your Spot',
      body:  isFreeEvent
        ? 'Your presence is your commitment. Join hundreds of others making this happen.'
        : 'Reserve your place and be part of the change this community is driving.',
      cta:   isFreeEvent ? 'Register Free' : 'Get Your Pass',
      href:  '#tickets',
    })
  }

  if (td?.volunteerInstructions?.trim()) {
    const text = td.volunteerInstructions.trim()
    paths.push({
      icon:  Heart,
      label: 'Volunteer',
      title: 'Give Your Time',
      body:  text.length > 110 ? text.slice(0, 107) + '…' : text,
      cta:   'Sign Up to Volunteer',
      href:  organizer?.email ? `mailto:${organizer.email}?subject=Volunteer%20Enquiry` : undefined,
    })
  }

  if (td?.impactGoal?.trim() || td?.causeInfo?.trim()) {
    paths.push({
      icon:  Megaphone,
      label: 'Advocate',
      title: 'Spread the Word',
      body:  'Every share reaches new people. Help us grow this movement by amplifying our message.',
      cta:   'Share the Campaign',
    })
  }

  if (organizer?.email || organizer?.website) {
    paths.push({
      icon:  Building2,
      label: 'Partner',
      title: 'Become a Sponsor',
      body:  'Support this cause as a corporate partner or NGO collaborator. Every contribution counts.',
      cta:   'Get in Touch',
      href:  organizer?.email
        ? `mailto:${organizer.email}?subject=Partnership%20Enquiry`
        : organizer?.website,
    })
  }

  if (paths.length === 0) return null

  return (
    <section className="bg-slate-50 py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            Get Involved
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            How you can help
          </h2>
        </motion.div>

        <div className={`grid gap-3 ${
          paths.length <= 2 ? 'sm:grid-cols-2' : paths.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4'
        }`}>
          {paths.map((path, i) => {
            const Icon = path.icon
            const inner = (
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.15 }}
                transition={{ delay: i * 0.08, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="group flex h-full flex-col rounded-2xl bg-white p-5 ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:ring-black/10"
              >
                {/* Icon */}
                <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-gray-50 ring-1 ring-black/5 transition-colors group-hover:bg-gray-100">
                  <Icon className="size-4.5 text-gray-600" aria-hidden />
                </div>

                {/* Label */}
                <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400">
                  {path.label}
                </p>

                {/* Title */}
                <h3 className="mb-2 text-[0.9375rem] font-black leading-snug text-gray-900">
                  {path.title}
                </h3>

                {/* Body */}
                <p className="flex-1 text-[0.8125rem] leading-relaxed text-gray-500">{path.body}</p>

                {/* CTA */}
                <div className="mt-5 flex items-center gap-1 text-[0.8125rem] font-bold text-gray-900 transition-all group-hover:gap-2">
                  {path.cta}
                  <ArrowRight className="size-3.5 shrink-0" aria-hidden />
                </div>
              </motion.div>
            )

            return path.href ? (
              <a key={i} href={path.href} className="flex" target={path.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
                {inner}
              </a>
            ) : (
              <div key={i} className="flex">{inner}</div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
