// ─── SportsOrganizer — who stands behind the race ────────────────────────────
//
// SPORTS-ONLY Server Component. The organiser's identity set as a masthead that rhymes
// with the cover's: the mark, the name at heading scale, the verification line, their
// own words (tagline, bio) — and the ways to reach them as quiet links on a hairline
// rather than a panel of buttons.
//
//   ┌──────────────────────────────────────────────────────────────────────────┐
//   │ ORGANIZER                                                                │
//   │ [mark]  UDHAYAM FOUNDATION                        Contact Organizer      │
//   │         Official Organizer · Since 2011           9791995131 · 959769…   │
//   │ ───────────────────────────────────────────────── udhayam.org · socials  │
//   │ tagline / bio                                                            │
//   └──────────────────────────────────────────────────────────────────────────┘
//
// Every figure is one the organiser actually entered (`eventsHosted`, `foundedYear`);
// nothing is counted, rated or inferred. The contact target is the canonical
// `resolveOrganizerContact` result the template passes in, so this page still has ONE
// answer to "Contact Organizer". A phone field holding several numbers — as this
// organiser's does — is split into one tel: link per number rather than one dead link
// containing all of them.

import { BadgeCheck, Phone, Mail, Globe, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { OrganizerInfo } from '@/components/wizard/eventDetailsConfig'
import { BODY, FIELD, QUIET_ACTION, SectionHead, SportsSection, ColumnHead, OUTLINE_ACTION, SPORTS_SCROLL_MT } from './primitives'

export interface SportsOrganizerProps {
  organizer:    OrganizerInfo
  showSocial?:  boolean
  /** The page's ONE contact target (resolveOrganizerContact). */
  contactHref?: string
  eyebrow?:     string
  title?:       string
  /** 'band' — the full-width section (default). 'column' — one half of the shared
   *  Hosted By | Proudly Supported By band. */
  layout?:      'band' | 'column'
}

/** "9791995131 or 9597691500" → ['9791995131', '9597691500'] — split, never invented. */
export function splitPhones(raw?: string): string[] {
  return (raw ?? '')
    .split(/[,;/]|\bor\b|\band\b|\|/i)
    .map(s => s.trim())
    .filter(s => /\d{5,}/.test(s))
}

export function SportsOrganizer({
  organizer, showSocial, contactHref, eyebrow = 'Organizer', title = 'Hosted By', layout = 'band',
}: SportsOrganizerProps) {
  const name = organizer.name?.trim()
  if (!name) return null

  const email  = organizer.email?.trim()
  const web    = organizer.website?.trim()
  const phones = splitPhones(organizer.phone)
  const s      = organizer.social
  const socials = showSocial ? ([
    s?.instagram && { label: 'Instagram', href: s.instagram },
    s?.facebook  && { label: 'Facebook',  href: s.facebook },
    s?.twitter   && { label: 'X',         href: s.twitter },
    s?.linkedin  && { label: 'LinkedIn',  href: s.linkedin },
    s?.youtube   && { label: 'YouTube',   href: s.youtube },
  ].filter(Boolean) as { label: string; href: string }[]) : []

  const facts = [
    organizer.foundedYear && { label: 'Established', value: String(organizer.foundedYear) },
    organizer.eventsHosted && organizer.eventsHosted > 0
      && { label: 'Events hosted', value: `${organizer.eventsHosted.toLocaleString('en-IN')}+` },
  ].filter(Boolean) as { label: string; value: string }[]

  const hasContact = !!(contactHref || email || phones.length || web || socials.length)

  if (layout === 'column') {
    return (
      <section id="organizer" className={cn(SPORTS_SCROLL_MT, 'min-w-0')}>
        <ColumnHead eyebrow={eyebrow} title={title} />

        {/* Identity — the mark, the name, the badge. */}
        <div className="mt-7 flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
          {organizer.logoUrl?.trim() ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={organizer.logoUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-20 shrink-0 rounded-surface border border-border/70 bg-white object-contain p-1.5"
            />
          ) : (
            <span aria-hidden className="flex size-20 shrink-0 items-center justify-center rounded-surface border border-hero-accent-rule/40 bg-card text-fs-xl font-semibold text-hero-accent-rule">
              {name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-balance text-fs-lg font-semibold leading-snug text-hero-ink">{name}</h3>
            <p className="mt-1.5 inline-flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <BadgeCheck className="size-3.5 text-action" aria-hidden />
              {organizer.verified ? 'Verified organizer' : 'Official Organizer'}
            </p>
            {facts.length > 0 && (
              <p className="mt-1 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {facts.map(f => `${f.label} ${f.value}`).join(' · ')}
              </p>
            )}
          </div>
        </div>

        {organizer.tagline?.trim() && (
          <p className="mt-5 text-center text-fs-md font-semibold leading-snug text-hero-ink sm:text-left">{organizer.tagline.trim()}</p>
        )}
        {organizer.bio?.trim() && (
          <p className={cn('mt-2 whitespace-pre-line', BODY)}>{organizer.bio.trim()}</p>
        )}

        {/* Reaching them — every route as an outlined control. */}
        {hasContact && (
          <div className="mt-6 border-t border-border/60 pt-5 text-center sm:text-left">
            <p className={FIELD}>Get in touch</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2.5 sm:justify-start">
              {contactHref && (
                <a href={contactHref} className={OUTLINE_ACTION}>
                  <Mail className="size-4 text-hero-accent-rule" aria-hidden />Contact Organizer
                </a>
              )}
              {phones.map(p => (
                <a key={p} href={`tel:${p.replace(/[^\d+]/g, '')}`} className={cn(OUTLINE_ACTION, 'tabular-nums')}>
                  <Phone className="size-4 text-hero-accent-rule" aria-hidden />{p}
                </a>
              ))}
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer" className={OUTLINE_ACTION}>
                  <Globe className="size-4 text-hero-accent-rule" aria-hidden />{web.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </div>
            {socials.length > 0 && (
              <ul className="mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2 sm:justify-start">
                {socials.map(link => (
                  <li key={link.label}>
                    <a href={link.href} target="_blank" rel="noopener noreferrer" className={QUIET_ACTION}>
                      {link.label}<ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    )
  }

  return (
    <SportsSection id="organizer">
      <SectionHead eyebrow={eyebrow} title={title} />

      <div className={cn('mt-9', hasContact && 'lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-12')}>

        {/* ── The wide column: identity ──────────────────────────────────────── */}
        <div className="min-w-0">
          <div className="flex items-center gap-4">
            {organizer.logoUrl?.trim() ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={organizer.logoUrl}
                alt=""
                loading="lazy"
                decoding="async"
                className="size-16 shrink-0 rounded-surface border border-border/70 bg-white object-contain p-1.5 sm:size-20"
              />
            ) : (
              <span aria-hidden className="flex size-16 shrink-0 items-center justify-center rounded-surface border border-border/70 bg-muted text-fs-lg font-bold text-foreground sm:size-20">
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <h3 className="text-balance text-fs-lg font-semibold leading-snug text-hero-ink">{name}</h3>
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <BadgeCheck className="size-3.5 text-action" aria-hidden />
                  {organizer.verified ? 'Verified organizer' : 'Official Organizer'}
                </span>
                {facts.map(f => (
                  <span key={f.label} className="uppercase tracking-[0.14em]">{f.label} {f.value}</span>
                ))}
              </p>
            </div>
          </div>

          {organizer.tagline?.trim() && (
            <p className="mt-5 max-w-[60ch] text-fs-md font-medium leading-snug text-foreground/85">{organizer.tagline.trim()}</p>
          )}
          {organizer.bio?.trim() && (
            <p className={cn('mt-3 max-w-[68ch] whitespace-pre-line', BODY)}>{organizer.bio.trim()}</p>
          )}
        </div>

        {/* ── Reaching them ──────────────────────────────────────────────────── */}
        {hasContact && (
          <div className="mt-8 min-w-0 border-t border-border/60 pt-6 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-12 lg:pt-1">
            <p className={FIELD}>Get in touch</p>
            <div className="mt-3 flex flex-col items-start gap-2.5">
              {contactHref && (
                <a href={contactHref} className={QUIET_ACTION}>
                  <Mail className="size-4" aria-hidden />Contact Organizer
                </a>
              )}
              {phones.map(p => (
                <a key={p} href={`tel:${p.replace(/[^\d+]/g, '')}`} className={QUIET_ACTION}>
                  <Phone className="size-4" aria-hidden />{p}
                </a>
              ))}
              {web && (
                <a href={web} target="_blank" rel="noopener noreferrer" className={QUIET_ACTION}>
                  <Globe className="size-4" aria-hidden />{web.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                </a>
              )}
            </div>

            {socials.length > 0 && (
              <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border/60 pt-4">
                {socials.map(link => (
                  <li key={link.label}>
                    <a href={link.href} target="_blank" rel="noopener noreferrer" className={QUIET_ACTION}>
                      {link.label}<ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </SportsSection>
  )
}
