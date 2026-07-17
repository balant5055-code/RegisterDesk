'use client'

// OrganizerShowcase — a trust-forward organiser profile shared by every template.
//
// Leads with identity and credibility (logo, name, tagline, bio, verified status,
// track record) and treats contact as a quiet footer — establishing professionalism,
// not just listing an email. 100% data-driven: every field renders only when present
// (no fabricated "verified" badge — it shows only when `verified === true`), and the
// section self-hides when there is no organiser name.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { BadgeCheck, Globe, Mail, Phone, ExternalLink, CalendarDays, Award } from 'lucide-react'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader, reveal } from '@/components/event-templates/shared/ui/framework'

const domain = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

export interface OrganizerShowcaseProps {
  organizer:   OrganizerInfo
  showSocial?: boolean
  eyebrow?:    string
  title?:      string
}

export function OrganizerShowcase({
  organizer, showSocial = true, eyebrow = 'Organizer', title = 'Hosted By',
}: OrganizerShowcaseProps) {
  const reduce = useReducedMotion()

  if (!organizer?.name?.trim()) return null

  const s = organizer.social
  const socials = showSocial ? ([
    s?.instagram && { label: 'Instagram', url: s.instagram },
    s?.linkedin  && { label: 'LinkedIn',  url: s.linkedin },
    s?.twitter   && { label: 'Twitter',   url: s.twitter },
    s?.facebook  && { label: 'Facebook',  url: s.facebook },
    s?.youtube   && { label: 'YouTube',   url: s.youtube },
  ].filter(Boolean) as { label: string; url: string }[]) : []

  const stats = [
    organizer.foundedYear && { icon: CalendarDays, label: `Since ${organizer.foundedYear}` },
    organizer.eventsHosted && organizer.eventsHosted > 0
      && { icon: Award, label: `${organizer.eventsHosted.toLocaleString('en-IN')}+ events hosted` },
  ].filter(Boolean) as { icon: typeof Award; label: string }[]

  const web   = organizer.website?.trim()
  const email = organizer.email?.trim()
  const phone = organizer.phone?.trim()
  const hasChannels = !!(web || email || phone || socials.length)

  return (
    <SectionShell id="organizer" maxW="4xl">

        <SectionHeader eyebrow={eyebrow} title={title} />

        <motion.div {...reveal(reduce)} className="rounded-3xl border border-border/50 bg-card p-6 shadow-sm sm:p-8">

          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            {/* logo / monogram */}
            <div className="shrink-0">
              {organizer.logoUrl?.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={organizer.logoUrl}
                  alt={organizer.name}
                  loading="lazy"
                  decoding="async"
                  className="size-16 rounded-2xl border border-border/60 bg-white object-contain p-1.5 shadow-sm sm:size-20"
                />
              ) : (
                <div
                  className="flex size-16 items-center justify-center rounded-2xl text-2xl font-black text-white shadow-sm sm:size-20"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                  aria-hidden
                >
                  {organizer.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            {/* identity */}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-[20px] font-bold leading-tight text-foreground">{organizer.name}</h3>
                {organizer.verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-bold text-primary">
                    <BadgeCheck className="size-3.5" aria-hidden />Verified
                  </span>
                )}
              </div>

              {organizer.tagline?.trim() && (
                <p className="mt-1 text-[14px] text-muted-foreground">{organizer.tagline}</p>
              )}

              {stats.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
                  {stats.map(st => (
                    <span key={st.label} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground/80">
                      <st.icon className="size-4 text-primary/70" aria-hidden />{st.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {organizer.bio?.trim() && (
            <p className="mt-5 whitespace-pre-line text-[14px] leading-relaxed text-muted-foreground">{organizer.bio}</p>
          )}

          {hasChannels && (
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-border/50 pt-5">
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-primary">
                  <Globe className="size-4 text-primary/70" aria-hidden />{domain(web)}
                </a>
              )}
              {email && (
                <a href={`mailto:${email}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-primary">
                  <Mail className="size-4 text-primary/70" aria-hidden />{email}
                </a>
              )}
              {phone && (
                <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-primary">
                  <Phone className="size-4 text-primary/70" aria-hidden />{phone}
                </a>
              )}

              {socials.length > 0 && (
                <>
                  <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />
                  <div className="flex flex-wrap items-center gap-2">
                    {socials.map(soc => (
                      <Link
                        key={soc.label} href={soc.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card px-3 py-1 text-[12px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                      >
                        {soc.label}<ExternalLink className="size-3" aria-hidden />
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

        </motion.div>
    </SectionShell>
  )
}
