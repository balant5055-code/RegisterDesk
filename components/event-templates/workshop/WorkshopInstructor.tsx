'use client'

import { motion } from 'framer-motion'
import { ExternalLink, Award } from 'lucide-react'
import { FaLinkedinIn, FaTwitter } from 'react-icons/fa'
import type { Speaker } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface WorkshopInstructorProps {
  trainers: Speaker[]
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function WorkshopInstructor({ trainers }: WorkshopInstructorProps) {
  if (!trainers.length) return null

  const lead  = trainers[0]!
  const rest  = trainers.slice(1)

  return (
    <section id="instructor" className="bg-gray-50 py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-8"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.20em] text-blue-600">
            {trainers.length === 1 ? 'Your Instructor' : 'Your Instructors'}
          </p>
          <h2 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
            Learn from the Experts
          </h2>
        </motion.div>

        {/* Lead instructor — large card */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="overflow-hidden rounded-2xl border border-gray-100 bg-white"
        >
          <div className="grid sm:grid-cols-[200px_1fr] lg:grid-cols-[240px_1fr]">

            {/* Photo */}
            <div className="flex items-start justify-center bg-gray-50 p-6 sm:block sm:p-0">
              <div className="aspect-square w-36 overflow-hidden rounded-2xl bg-gray-200 sm:aspect-auto sm:h-full sm:w-full sm:rounded-none">
                {lead.photoUrl?.trim() ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={lead.photoUrl}
                    alt={lead.name}
                    className="h-full w-full object-cover object-top"
                  />
                ) : (
                  <div className="flex h-full min-h-[180px] w-full items-center justify-center bg-blue-100 text-3xl font-black text-blue-300">
                    {lead.name.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="flex flex-col justify-center p-6 lg:p-8">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-xl font-black tracking-tight text-gray-950 sm:text-2xl">
                  {lead.name}
                </h3>
                <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-0.5 text-[10.5px] font-bold text-blue-700">
                  <Award className="size-3" aria-hidden />
                  Lead Instructor
                </span>
              </div>

              {(lead.title || lead.company) && (
                <p className="mb-4 text-[0.875rem] font-medium text-gray-500">
                  {lead.title}
                  {lead.title && lead.company && ' · '}
                  {lead.company}
                </p>
              )}

              {lead.bio?.trim() && (
                <p className="mb-5 text-[0.9375rem] leading-relaxed text-gray-600">
                  {lead.bio}
                </p>
              )}

              {/* Social links */}
              {(lead.social?.linkedin?.trim() || lead.social?.twitter?.trim()) && (
                <div className="flex items-center gap-3">
                  {lead.social.linkedin?.trim() && (
                    <a
                      href={lead.social.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${lead.name} on LinkedIn`}

                      className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-all hover:bg-blue-50 hover:text-blue-700"
                    >
                      <FaLinkedinIn className="size-3.5" aria-hidden />
                      LinkedIn
                      <ExternalLink className="size-2.5 text-gray-400" aria-hidden />
                    </a>
                  )}
                  {lead.social.twitter?.trim() && (
                    <a
                      href={lead.social.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${lead.name} on X`}
                      className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-all hover:bg-sky-50 hover:text-sky-700"
                    >
                      <FaTwitter className="size-3.5" aria-hidden />
                      Twitter
                      <ExternalLink className="size-2.5 text-gray-400" aria-hidden />
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Additional instructors */}
        {rest.length > 0 && (
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((trainer, i) => (
              <motion.div
                key={trainer.id}
                initial={{ opacity: 0, y: 14 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.38, delay: i * 0.07 }}
                className="flex gap-4 rounded-xl border border-gray-100 bg-white p-4"
              >
                <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-gray-100">
                  {trainer.photoUrl?.trim() ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={trainer.photoUrl} alt={trainer.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-blue-100 text-lg font-black text-blue-300">
                      {trainer.name.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-gray-900">{trainer.name}</p>
                  {(trainer.title || trainer.company) && (
                    <p className="mt-0.5 truncate text-[12px] text-gray-500">
                      {trainer.title}{trainer.title && trainer.company && ' · '}{trainer.company}
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    {trainer.social?.linkedin?.trim() && (
                      <a href={trainer.social.linkedin} target="_blank" rel="noopener noreferrer"
                        className="text-gray-400 transition-colors hover:text-blue-600" aria-label="LinkedIn">
                        <FaLinkedinIn className="size-3.5" />
                      </a>
                    )}
                    {trainer.social?.twitter?.trim() && (
                      <a href={trainer.social.twitter} target="_blank" rel="noopener noreferrer"
                        className="text-gray-400 transition-colors hover:text-sky-600" aria-label="Twitter">
                        <FaTwitter className="size-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}

      </div>
    </section>
  )
}
