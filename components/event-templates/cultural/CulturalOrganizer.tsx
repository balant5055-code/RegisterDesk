'use client'

import { motion } from 'framer-motion'
import { Globe, Mail, Phone, ShieldCheck } from 'lucide-react'
import { FaLinkedinIn, FaTwitter, FaInstagram, FaYoutube } from 'react-icons/fa'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CulturalOrganizerProps {
  organizer:  OrganizerInfo
  showSocial: boolean
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CulturalOrganizer({ organizer, showSocial }: CulturalOrganizerProps) {
  if (!organizer?.name?.trim()) return null

  const contactLinks = [
    organizer.website?.trim() && { Icon: Globe, href: organizer.website,           label: 'Website' },
    organizer.email?.trim()   && { Icon: Mail,  href: `mailto:${organizer.email}`, label: organizer.email },
    organizer.phone?.trim()   && { Icon: Phone, href: `tel:${organizer.phone}`,    label: organizer.phone },
  ].filter(Boolean) as { Icon: typeof Globe; href: string; label: string }[]

  const socialLinks = showSocial ? [
    organizer.social?.twitter?.trim()   && { Icon: FaTwitter,    href: organizer.social.twitter,   label: 'Twitter'   },
    organizer.social?.linkedin?.trim()  && { Icon: FaLinkedinIn, href: organizer.social.linkedin,  label: 'LinkedIn'  },
    organizer.social?.instagram?.trim() && { Icon: FaInstagram,  href: organizer.social.instagram, label: 'Instagram' },
    organizer.social?.youtube?.trim()   && { Icon: FaYoutube,    href: organizer.social.youtube,   label: 'YouTube'   },
  ].filter(Boolean) as { Icon: typeof FaLinkedinIn; href: string; label: string }[] : []

  const allLinks = [...contactLinks, ...socialLinks] as { Icon: any; href: string; label: string }[]

  return (
    <section className="bg-gray-950 py-14 sm:py-18">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.5 }}
          className="mb-6"
        >
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.22em] text-amber-400">
            Organiser
          </p>
          <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">
            About the Organiser
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.45 }}
          className="overflow-hidden rounded-2xl border border-white/10 bg-gray-900"
        >
          {/* Verified banner */}
          <div className="flex items-center gap-2 border-b border-white/5 bg-emerald-500/10 px-5 py-2">
            <ShieldCheck className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
            <p className="text-[11px] font-semibold text-emerald-300">
              Verified Organiser on RegisterDesk
            </p>
          </div>

          <div className="p-5 sm:p-6">
            <div className="flex items-center gap-4">
              {organizer.logoUrl?.trim() ? (
                <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={organizer.logoUrl}
                    alt={organizer.name}
                    className="h-full w-full object-contain p-1"
                  />
                </div>
              ) : (
                <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-rose-600 text-xl font-black text-white">
                  {organizer.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="font-black text-white sm:text-lg">{organizer.name}</h3>
              </div>
            </div>

            {allLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-white/5 pt-4">
                {allLinks.map(({ Icon, href, label }) => (
                  <a
                    key={label}
                    href={href}
                    target={href.startsWith('http') ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-white/50 transition-all hover:bg-amber-400/10 hover:text-amber-300"
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {label}
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
