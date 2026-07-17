'use client'

import { motion } from 'framer-motion'
import { Globe, Mail, Phone, ShieldCheck } from 'lucide-react'
import { FaLinkedinIn, FaTwitter, FaInstagram, FaYoutube } from 'react-icons/fa'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'

// ─── Props ─────────────────────────────────────────────────────────────────────

interface CommunityOrganizerProps {
  organizer:  OrganizerInfo
  showSocial: boolean
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function CommunityOrganizer({ organizer, showSocial }: CommunityOrganizerProps) {
  if (!organizer?.name?.trim()) return null

  const contactLinks = [
    organizer.website?.trim() && { Icon: Globe, href: organizer.website,           label: 'Website'        },
    organizer.email?.trim()   && { Icon: Mail,  href: `mailto:${organizer.email}`, label: organizer.email  },
    organizer.phone?.trim()   && { Icon: Phone, href: `tel:${organizer.phone}`,    label: organizer.phone  },
  ].filter(Boolean) as { Icon: typeof Globe; href: string; label: string }[]

  const socialLinks = showSocial ? [
    organizer.social?.twitter?.trim()   && { Icon: FaTwitter,    href: organizer.social.twitter,   label: 'Twitter'   },
    organizer.social?.linkedin?.trim()  && { Icon: FaLinkedinIn, href: organizer.social.linkedin,  label: 'LinkedIn'  },
    organizer.social?.instagram?.trim() && { Icon: FaInstagram,  href: organizer.social.instagram, label: 'Instagram' },
    organizer.social?.youtube?.trim()   && { Icon: FaYoutube,    href: organizer.social.youtube,   label: 'YouTube'   },
  ].filter(Boolean) as { Icon: typeof FaLinkedinIn; href: string; label: string }[] : []

  const allLinks = [...contactLinks, ...socialLinks] as { Icon: any; href: string; label: string }[]

  return (
    <section className="bg-slate-50 py-10 sm:py-14">
      <div className="mx-auto max-w-5xl px-5 sm:px-10">

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.1 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="mb-6"
        >
          <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
            Organised By
          </p>
          <h2 className="text-[1.25rem] font-black tracking-tight text-gray-900 sm:text-[1.625rem]">
            Meet the Organisation
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.05 }}
          transition={{ duration: 0.45, ease: [0.25, 0, 0, 1] }}
          className="overflow-hidden rounded-2xl border border-gray-100 bg-white"
        >
          {/* Verified banner */}
          <div className="flex items-center gap-2 border-b border-gray-50 bg-emerald-50 px-5 py-2">
            <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
            <p className="text-[11px] font-semibold text-emerald-700">Verified Organiser on RegisterDesk</p>
          </div>

          <div className="p-5 sm:p-6">
            <div className="flex items-center gap-4">
              {/* Logo or initial */}
              {organizer.logoUrl?.trim() ? (
                <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-gray-100 ring-1 ring-gray-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={organizer.logoUrl}
                    alt={organizer.name}
                    className="h-full w-full object-contain p-1"
                  />
                </div>
              ) : (
                <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-xl font-black text-emerald-500">
                  {organizer.name.charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <h3 className="font-black text-gray-950 sm:text-lg">{organizer.name}</h3>
              </div>
            </div>

            {allLinks.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
                {allLinks.map(({ Icon, href, label }) => (
                  <a
                    key={label}
                    href={href}
                    target={href.startsWith('http') ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-[12px] font-semibold text-gray-600 transition-all hover:bg-emerald-50 hover:text-emerald-700"
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
