'use client'

import { motion } from 'framer-motion'
import { Globe, Mail, Phone, ShieldCheck } from 'lucide-react'
import { FaLinkedinIn, FaTwitter, FaInstagram, FaYoutube } from 'react-icons/fa'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AwardsOrganizerProps {
  organizer:  OrganizerInfo
  showSocial: boolean
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function AwardsOrganizer({ organizer, showSocial }: AwardsOrganizerProps) {
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
    <section className="bg-zinc-950 py-14 sm:py-20">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.6 }}
          className="mb-6"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-px w-8 bg-yellow-400/50" />
            <p className="text-[11px] font-bold uppercase tracking-[0.26em] text-yellow-400">
              Organiser
            </p>
          </div>
          <h2 className="text-xl font-black tracking-tight text-white sm:text-2xl">
            About the Organiser
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.5 }}
          className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900"
        >
          {/* Verified banner */}
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-emerald-500/8 px-5 py-2">
            <ShieldCheck className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
            <p className="text-[11px] font-semibold text-emerald-400">
              Verified Organiser on RegisterDesk
            </p>
          </div>

          <div className="p-5 sm:p-6">
            <div className="flex items-center gap-4">
              {organizer.logoUrl?.trim() ? (
                <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-zinc-800 ring-1 ring-zinc-700">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={organizer.logoUrl}
                    alt={organizer.name}
                    className="h-full w-full object-contain p-1"
                  />
                </div>
              ) : (
                <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-yellow-400/20 bg-yellow-400/8 text-xl font-black text-yellow-400">
                  {organizer.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="font-black text-white sm:text-lg">{organizer.name}</h3>
              </div>
            </div>

            {allLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
                {allLinks.map(({ Icon, href, label }) => (
                  <a
                    key={label}
                    href={href}
                    target={href.startsWith('http') ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-[12px] font-semibold text-zinc-400 transition-all hover:bg-zinc-700 hover:text-yellow-400"
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
