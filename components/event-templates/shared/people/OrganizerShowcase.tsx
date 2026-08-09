'use client'

// OrganizerShowcase — the organiser as a credible profile, not an information card.
//
// RD-ST10.0 rework. The data was already right; the PRIORITY was not. Name, tagline,
// track record, website, email, phone and social links all sat at roughly the same
// visual weight in one flowing card, and contact was a footer strip of equal-sized
// text links — so nothing established trust, it merely listed facts.
//
// It is now a two-column profile:
//
//   LEFT  — identity. Large logo, name, verification and Official Organizer badges,
//           established year, tagline and bio. This is the trust story.
//   RIGHT — proof and action. Statistic cards, then ONE grouped action block:
//           Contact Organizer (primary) with website and socials beneath.
//
// Nothing is added to the data model. Every field renders only when the organiser set
// it, the section self-hides without a name, and the "Verified" badge still appears
// only when `verified === true`.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { BadgeCheck, ShieldCheck, Globe, Mail, Phone, ExternalLink, CalendarDays, Award } from 'lucide-react'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD, CARD_PAD_LG,
  BRAND_GRADIENT, reveal, GRID_GAP, type SectionBg,
} from '@/components/event-templates/shared/ui/framework'

const domain = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

export interface OrganizerShowcaseProps {
  organizer:   OrganizerInfo
  showSocial?: boolean
  eyebrow?:    string
  title?:      string
  subtitle?:   string
  /**
   * RD-ST15.0: canonical contact target from `resolveOrganizerContact`, so this button
   * and the FAQ / Policies contact links can never resolve to different addresses.
   * Omit to keep the organiser's own email → phone precedence.
   */
  contactHref?: string
  /**
   * RD-ST5.2 P0.2 — the band background, chosen by the TEMPLATE rather than here.
   *
   * A section cannot see the sequence it sits in, which is how the page grew eight
   * consecutive white bands. Defaults to the previous value, so every existing call
   * site is unchanged.
   */
  bg?: SectionBg
}

export function OrganizerShowcase({
  organizer, showSocial = true, eyebrow = 'Organizer', title = 'Hosted By', subtitle,
  contactHref, bg = 'white',
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

  const web   = organizer.website?.trim()
  const email = organizer.email?.trim()
  const phone = organizer.phone?.trim()

  // Statistic cards — real figures only. `eventsHosted` and `foundedYear` are the only
  // organiser metrics the schema carries; a value that is unset simply has no card.
  const stats = [
    organizer.eventsHosted && organizer.eventsHosted > 0 && {
      icon: Award, value: `${organizer.eventsHosted.toLocaleString('en-IN')}+`, label: 'Events hosted',
    },
    organizer.foundedYear && {
      icon: CalendarDays, value: String(organizer.foundedYear), label: 'Established',
    },
  ].filter(Boolean) as { icon: typeof Award; value: string; label: string }[]

  // ONE grouped action block — primary contact, then the organiser's own channels.
  // The canonical href wins when the page supplies one; otherwise this falls back to the
  // organiser's own email → phone precedence, so every existing call site is unchanged.
  const resolvedHref = contactHref?.trim() || (email ? `mailto:${email}` : phone ? `tel:${phone}` : '')
  const isTel        = resolvedHref.startsWith('tel:')
  const contactLabel = isTel ? 'Call Organizer' : 'Contact Organizer'
  const hasActions   = !!(resolvedHref || web || socials.length)

  const ACTION_BTN =
    'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-fs-sm font-semibold text-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

  return (
    <SectionShell id="organizer" bg={bg}>
      <EventSectionHeader eyebrow={eyebrow} title={title} description={subtitle} />

      <motion.div {...reveal(reduce)} className="grid gap-6 lg:grid-cols-12 lg:gap-8">

        {/* ══════════ LEFT · identity ══════════ */}
        <div className={cn(CARD, CARD_PAD_LG, 'lg:col-span-7')}>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
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
                  className={cn('flex size-16 items-center justify-center rounded-2xl text-2xl font-black text-white shadow-sm sm:size-20', BRAND_GRADIENT)}
                  aria-hidden
                >
                  {organizer.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h3 className={TYPE.cardTitleLg}>{organizer.name}</h3>

              {/* Verification — the trust signal, directly under the name. */}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {organizer.verified && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-fs-2xs font-bold text-primary">
                    <BadgeCheck className="size-3.5" aria-hidden />Verified
                  </span>
                )}
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-fs-2xs font-bold text-foreground">
                  <ShieldCheck className="size-3.5 text-primary" aria-hidden />Official Organizer
                </span>
                {organizer.foundedYear && (
                  <span className="inline-flex items-center gap-1 text-fs-2xs font-medium text-muted-foreground">
                    <CalendarDays className="size-3.5 text-primary/70" aria-hidden />Since {organizer.foundedYear}
                  </span>
                )}
              </div>

              {organizer.tagline?.trim() && (
                <p className="mt-3 text-fs-base text-muted-foreground">{organizer.tagline}</p>
              )}
            </div>
          </div>

          {organizer.bio?.trim() && (
            <p className="mt-5 max-w-[70ch] whitespace-pre-line border-t border-border/40 pt-5 text-fs-base leading-relaxed text-muted-foreground">
              {organizer.bio}
            </p>
          )}
        </div>

        {/* ══════════ RIGHT · proof + actions ══════════ */}
        <div className="flex flex-col gap-4 lg:col-span-5">

          {stats.length > 0 && (
            <div className={cn('grid', GRID_GAP, stats.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
              {stats.map(st => (
                <div key={st.label} className={cn(CARD, CARD_PAD, 'flex flex-col justify-between')}>
                  <st.icon className="size-[18px] text-primary" aria-hidden />
                  <p className={cn('mt-3', TYPE.statValue)}>{st.value}</p>
                  <p className={cn('mt-1', TYPE.label)}>{st.label}</p>
                </div>
              ))}
            </div>
          )}

          {hasActions && (
            <div className={cn(CARD, CARD_PAD)}>
              <p className={TYPE.label}>Get in touch</p>

              <div className="mt-3 flex flex-col gap-2.5">
                {resolvedHref && (
                  <a
                    href={resolvedHref}
                    className={cn(ACTION_BTN, 'border-transparent text-white shadow-sm hover:brightness-105', BRAND_GRADIENT)}
                  >
                    {isTel ? <Phone className="size-4" aria-hidden /> : <Mail className="size-4" aria-hidden />}
                    {contactLabel}
                  </a>
                )}

                {web && (
                  <a href={web} target="_blank" rel="noopener noreferrer" className={ACTION_BTN}>
                    <Globe className="size-4 text-primary" aria-hidden />
                    <span className="truncate">{domain(web)}</span>
                    <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </a>
                )}

                {/* Secondary contact channel — only when it is not already the primary. */}
                {phone && !isTel && (
                  <a href={`tel:${phone}`} className={ACTION_BTN}>
                    <Phone className="size-4 text-primary" aria-hidden />{phone}
                  </a>
                )}
              </div>

              {socials.length > 0 && (
                <div className="mt-4 border-t border-border/40 pt-4">
                  <p className={TYPE.label}>Follow</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {socials.map(soc => (
                      <Link
                        key={soc.label}
                        href={soc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${organizer.name} on ${soc.label}`}
                        className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card px-3 py-1.5 text-fs-xs font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        {soc.label}<ExternalLink className="size-3" aria-hidden />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </SectionShell>
  )
}
