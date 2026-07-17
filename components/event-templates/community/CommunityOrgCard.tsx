'use client'

import { motion } from 'framer-motion'
import { Globe, Mail, Phone, ExternalLink, ShieldCheck } from 'lucide-react'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

interface SocialLink { href: string; label: string }

export function CommunityOrgCard({
  organizer, showSocial,
}: {
  organizer:  OrganizerInfo
  showSocial: boolean
}) {
  if (!organizer.name) return null

  const socials: SocialLink[] = showSocial ? [
    { href: organizer.social?.instagram ?? '', label: 'Instagram' },
    { href: organizer.social?.linkedin  ?? '', label: 'LinkedIn'  },
    { href: organizer.social?.twitter   ?? '', label: 'Twitter'   },
    { href: organizer.social?.youtube   ?? '', label: 'YouTube'   },
    { href: organizer.social?.facebook  ?? '', label: 'Facebook'  },
  ].filter(s => s.href.trim()) : []

  return (
    <section className="border-t border-gray-100 bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.2 }}
          transition={{ duration: 0.55 }}
          className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8"
        >
          {/* Logo */}
          {organizer.logoUrl && (
            <div className="shrink-0">
              <div className="size-16 overflow-hidden rounded-xl border border-gray-100 bg-gray-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={organizer.logoUrl}
                  alt={organizer.name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>
            </div>
          )}

          <div className="min-w-0 flex-1">
            {/* Trust badge */}
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5">
              <ShieldCheck className="size-3 text-primary" aria-hidden />
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                Verified Organiser
              </span>
            </div>

            <h3 className="mb-2 text-[1rem] font-black text-gray-900">{organizer.name}</h3>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
              {organizer.website?.trim() && (
                <a
                  href={organizer.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[0.8125rem] text-gray-500 transition-colors hover:text-gray-900"
                >
                  <Globe className="size-3.5 shrink-0" aria-hidden />
                  {organizer.website.replace(/^https?:\/\//, '')}
                </a>
              )}
              {organizer.email?.trim() && (
                <a
                  href={`mailto:${organizer.email}`}
                  className="flex items-center gap-1.5 text-[0.8125rem] text-gray-500 transition-colors hover:text-gray-900"
                >
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  {organizer.email}
                </a>
              )}
              {organizer.phone?.trim() && (
                <a
                  href={`tel:${organizer.phone}`}
                  className="flex items-center gap-1.5 text-[0.8125rem] text-gray-500 transition-colors hover:text-gray-900"
                >
                  <Phone className="size-3.5 shrink-0" aria-hidden />
                  {organizer.phone}
                </a>
              )}
            </div>

            {socials.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {socials.map(({ href, label }) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[0.75rem] font-semibold text-gray-600 transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                  >
                    {label}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  )
}
