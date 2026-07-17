'use client'

import type React from 'react'
import { motion } from 'framer-motion'
import { Globe, Mail, Phone, ShieldCheck, ExternalLink } from 'lucide-react'
import { FaFacebookF, FaLinkedinIn, FaTwitter, FaYoutube, FaInstagram } from 'react-icons/fa'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

// ─── Component ─────────────────────────────────────────────────────────────────

export function ConferenceOrganizer({
  organizer, showSocial,
}: { organizer: OrganizerInfo; showSocial: boolean }) {
  if (!organizer.name?.trim()) return null

  const socialLinks = showSocial ? [
    organizer.social?.linkedin  && { Icon: FaLinkedinIn, href: organizer.social.linkedin,  label: 'LinkedIn'  },
    organizer.social?.twitter   && { Icon: FaTwitter,   href: organizer.social.twitter,   label: 'X'         },
    organizer.social?.facebook  && { Icon: FaFacebookF, href: organizer.social.facebook,  label: 'Facebook'  },
    organizer.social?.instagram && { Icon: FaInstagram, href: organizer.social.instagram, label: 'Instagram' },
    organizer.social?.youtube   && { Icon: FaYoutube,   href: organizer.social.youtube,   label: 'YouTube'   },
  ].filter(Boolean) as { Icon: React.ElementType; href: string; label: string }[] : []

  const hasContact = !!(organizer.email || organizer.phone || organizer.website)

  return (
    <section className="bg-gray-50 py-16 sm:py-20">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
          className="mb-10"
        >
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Hosted by</p>
          <h2 className="text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">Organiser</h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]"
        >

          {/* Verified banner */}
          <div className="flex items-center gap-2 border-b border-gray-100 bg-emerald-50 px-6 py-2.5">
            <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            <p className="text-[11.5px] font-semibold text-emerald-700">
              Verified Organiser on RegisterDesk
            </p>
          </div>

          <div className="grid gap-0 sm:grid-cols-[1fr_auto]">

            {/* Left: profile */}
            <div className="flex flex-wrap items-start gap-5 p-6 sm:p-8">
              {organizer.logoUrl?.trim() && (
                <div className="size-16 shrink-0 overflow-hidden rounded-xl border border-gray-100 bg-gray-50 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={organizer.logoUrl}
                    alt={organizer.name}
                    className="h-full w-full object-contain"
                  />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <h3 className="text-[1.0625rem] font-bold text-gray-950">{organizer.name}</h3>

                {/* Social links */}
                {socialLinks.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {socialLinks.map(({ Icon, href, label }) => (
                      <a
                        key={label}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={label}
                        className="flex size-8 items-center justify-center rounded-lg border border-gray-100 bg-gray-50 text-gray-400 transition-all hover:border-primary/20 hover:bg-primary/[0.06] hover:text-primary"
                      >
                        <Icon className="size-3.5" aria-hidden />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right: contact */}
            {hasContact && (
              <div className="border-t border-gray-100 p-6 sm:border-l sm:border-t-0 sm:p-8 sm:min-w-[220px]">
                <p className="mb-3 text-[10.5px] font-bold uppercase tracking-[0.18em] text-gray-400">
                  Contact
                </p>
                <div className="flex flex-col gap-2.5">
                  {organizer.email && (
                    <a
                      href={`mailto:${organizer.email}`}
                      className="group flex items-center gap-2 text-[0.8125rem] text-gray-600 transition-colors hover:text-primary"
                    >
                      <Mail className="size-3.5 shrink-0 text-gray-400 group-hover:text-primary" aria-hidden />
                      <span className="break-all">{organizer.email}</span>
                    </a>
                  )}
                  {organizer.phone && (
                    <a
                      href={`tel:${organizer.phone}`}
                      className="group flex items-center gap-2 text-[0.8125rem] text-gray-600 transition-colors hover:text-primary"
                    >
                      <Phone className="size-3.5 shrink-0 text-gray-400 group-hover:text-primary" aria-hidden />
                      {organizer.phone}
                    </a>
                  )}
                  {organizer.website && (
                    <a
                      href={organizer.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group flex items-center gap-2 text-[0.8125rem] text-gray-600 transition-colors hover:text-primary"
                    >
                      <Globe className="size-3.5 shrink-0 text-gray-400 group-hover:text-primary" aria-hidden />
                      <span className="truncate">{organizer.website.replace(/^https?:\/\//, '')}</span>
                      <ExternalLink className="size-3 shrink-0 opacity-50" aria-hidden />
                    </a>
                  )}
                </div>
              </div>
            )}

          </div>
        </motion.div>

      </div>
    </section>
  )
}
