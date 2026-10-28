// Custom Event template — the compact body sections.
//
// Every section is a LuxeBlock in the main column, so they share one header, one rhythm
// and one left edge (the shared *Showcase sections are full-bleed bands with their own
// headers, which is what made the page read as mismatched). Each renders nothing when
// its data is absent — hide-when-empty, never a placeholder.
//
// Data handling reuses the shared helpers (getVideoEmbed, mediaToGallery,
// resolveOrganizerContact, the EventInfoSection label helpers); only the markup is local.

import { ArrowUpRight, Navigation, Mail, Phone, Globe, Plus, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import type {
  AgendaSession, Speaker, Sponsor, OrganizerInfo, GalleryItem, FaqItem,
  PhysicalVenueConfig, OnlineVenueConfig, VenueMaps, RefundWindow,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { formatDate, formatTime, getVideoEmbed } from '@/components/event-templates/shared/utils/format'
import { resolveOrganizerContact } from '@/components/event-templates/shared/people/contactModel'
import { languageLabel, timezoneLabel, refundLines } from '@/components/event-templates/shared/ui/EventInfoSection'
import { AttachmentChips } from '@/components/event-templates/shared/ui/framework'
import { RichText } from '@/components/event-templates/shared/ui/RichText'
import { LuxeBlock, LUXE_CARD, LUXE_LABEL } from './luxe'

const BODY = 'text-fs-base text-hero-ink-soft leading-relaxed'

// ─── About ──────────────────────────────────────────────────────────────────────
export function AboutBlock({ description }: { description: string }) {
  if (!description?.trim()) return null
  // RD-MARKDOWN-01 — the wizard's promised Markdown subset, rendered safely (shared/ui/RichText).
  return (
    <LuxeBlock id="about" eyebrow="The occasion" title="About the event">
      <RichText text={description} className={cn('max-w-2xl space-y-4', BODY)} />
    </LuxeBlock>
  )
}

// ─── Film ───────────────────────────────────────────────────────────────────────
export function FilmBlock({ url, title }: { url: string; title: string }) {
  const src = getVideoEmbed(url)
  if (!src) return null
  return (
    <LuxeBlock id="film" eyebrow="Film" title="A glimpse of the event">
      <div className={cn(LUXE_CARD, 'overflow-hidden')}>
        <iframe
          src={src}
          title={`${title} — video`}
          className="aspect-video w-full"
          loading="lazy"
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    </LuxeBlock>
  )
}

// ─── Programme ──────────────────────────────────────────────────────────────────
export function ProgrammeBlock({ agenda, speakers }: { agenda: AgendaSession[]; speakers: Speaker[] }) {
  const items = [...(agenda ?? [])]
    .filter(s => s?.title?.trim())
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.startTime || '').localeCompare(b.startTime || '') || a.order - b.order)
  if (items.length === 0) return null

  const byId = new Map(speakers.map(s => [s.id, s.name]))
  const days = [...new Set(items.map(s => s.date || ''))]
  const multiDay = days.length > 1

  return (
    <LuxeBlock id="programme" eyebrow="Programme" title="How the day unfolds">
      <div className="space-y-6">
        {days.map(day => (
          <div key={day || 'undated'}>
            {multiDay && day && <p className={cn(LUXE_LABEL, 'mb-2')}>{formatDate(day)}</p>}
            <ol className={cn(LUXE_CARD, 'divide-y divide-border/60')}>
              {items.filter(s => (s.date || '') === day).map(s => {
                const names = (s.speakerIds ?? []).map(id => byId.get(id)).filter(Boolean)
                return (
                  <li key={s.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-4 px-5 py-3.5 sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <p className="pt-0.5 text-fs-xs font-medium tabular-nums text-hero-eyebrow">
                      {s.startTime ? formatTime(s.startTime) : ''}
                      {s.endTime ? <span className="block text-hero-ink-soft/70">{formatTime(s.endTime)}</span> : null}
                    </p>
                    <div className="min-w-0">
                      <p className={cn('text-fs-sm font-medium leading-snug', s.isBreak ? 'text-hero-ink-soft' : 'text-hero-ink')}>{s.title}</p>
                      {s.description?.trim() && <p className="mt-1 text-fs-xs text-hero-ink-soft leading-relaxed">{s.description}</p>}
                      {(names.length > 0 || s.location?.trim()) && (
                        <p className="mt-1 text-fs-xs text-hero-eyebrow">
                          {[names.join(', '), s.location?.trim()].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </div>
        ))}
      </div>
    </LuxeBlock>
  )
}

// ─── Speakers ───────────────────────────────────────────────────────────────────
export function SpeakersBlock({ speakers }: { speakers: Speaker[] }) {
  const list = [...(speakers ?? [])].filter(s => s?.name?.trim()).sort((a, b) => a.order - b.order)
  if (list.length === 0) return null
  return (
    <LuxeBlock id="speakers" eyebrow="Guests" title="Speakers & guests">
      <ul className="grid gap-3 sm:grid-cols-2">
        {list.map(s => (
          <li key={s.id} className={cn(LUXE_CARD, 'flex items-center gap-3.5 p-4')}>
            {s.photoUrl?.trim() ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.photoUrl} alt="" className="size-12 shrink-0 rounded-pill border border-border/60 object-cover" loading="lazy" />
            ) : (
              <span aria-hidden className="inline-flex size-12 shrink-0 items-center justify-center rounded-pill border border-hero-accent-rule/40 bg-surface-3/60 font-display text-fs-lg text-hero-accent-rule">
                {s.name.trim().charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <p className="truncate text-fs-sm font-medium text-hero-ink">{s.name}</p>
              {(s.title?.trim() || s.company?.trim()) && (
                <p className="truncate text-fs-xs text-hero-ink-soft">{[s.title?.trim(), s.company?.trim()].filter(Boolean).join(' · ')}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </LuxeBlock>
  )
}

// ─── Venue ──────────────────────────────────────────────────────────────────────
export function VenueBlock({ venueType, venueName, physical, online, mapsLink, maps }: {
  venueType: 'physical' | 'online' | 'hybrid'
  venueName: string
  physical?: PhysicalVenueConfig
  online?:   OnlineVenueConfig
  mapsLink:  string
  maps:      VenueMaps | null
}) {
  const addr     = physical
  const lines    = [addr?.addressLine1, addr?.addressLine2].map(s => s?.trim()).filter(Boolean) as string[]
  const cityLine = [addr?.city, addr?.state, addr?.pincode].map(s => s?.trim()).filter(Boolean).join(', ')
  // Same existence rule as VenueShowcase: real address atoms, never the "Venue TBA" label.
  const hasAddress  = !!(addr?.name?.trim() || lines.length || cityLine || mapsLink?.trim())
  const hasPhysical = venueType !== 'online' && hasAddress
  const hasOnline   = venueType !== 'physical'
    && !!(online?.meetingUrl?.trim() || online?.joinInstructions?.trim() || online?.platform)
  if (!hasPhysical && !hasOnline) return null

  const name  = addr?.name?.trim() || venueName?.trim() || ''
  const query = [name, addr?.addressLine1, addr?.addressLine2, addr?.city, addr?.state, addr?.pincode, addr?.country]
    .map(s => s?.trim()).filter(Boolean).join(', ')
  const embedSrc   = query ? `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=14&output=embed` : ''
  const directions = mapsLink?.trim() || (query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '')
  const mapLinks = [
    { label: 'Venue layout', url: maps?.layoutImageUrl ?? '' },
    { label: 'Parking',      url: maps?.parkingMapUrl ?? '' },
    { label: 'Entry gate',   url: maps?.entryGateMapUrl ?? '' },
  ].filter(m => m.url.trim())
  const platform = online
    ? (online.platform === 'custom' && online.platformCustomName?.trim()
        ? online.platformCustomName.trim()
        : ONLINE_PLATFORM_LABELS[online.platform] ?? 'Online')
    : 'Online'

  return (
    <LuxeBlock id="venue" eyebrow="Venue" title={hasPhysical ? 'Where it happens' : 'How to join'}>
      <div className="space-y-3">
        {hasPhysical && (
          <div className={cn(LUXE_CARD, 'grid overflow-hidden sm:grid-cols-5')}>
            {embedSrc && (
              <div className="relative aspect-[16/10] border-b border-border/60 bg-surface-3 sm:col-span-3 sm:border-b-0 sm:border-r">
                <iframe
                  src={embedSrc}
                  title={`Map — ${name}`}
                  className="absolute inset-0 size-full"
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
              </div>
            )}
            <div className={cn('flex flex-col gap-4 p-5', embedSrc ? 'sm:col-span-2' : 'sm:col-span-5')}>
              <div>
                <p className="font-display text-fs-lg text-hero-ink leading-snug">{name}</p>
                {(lines.length > 0 || cityLine) && (
                  <p className="mt-1.5 text-fs-sm text-hero-ink-soft leading-relaxed">
                    {[...lines, cityLine].filter(Boolean).join(', ')}
                  </p>
                )}
                {addr?.instructions?.trim() && (
                  <p className="mt-3 whitespace-pre-line border-t border-border/60 pt-3 text-fs-xs text-hero-ink-soft leading-relaxed">{addr.instructions}</p>
                )}
              </div>
              <div className="mt-auto space-y-3">
                {mapLinks.length > 0 && <AttachmentChips links={mapLinks} />}
                {directions && (
                  <a
                    href={directions}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(marketingButton({ variant: 'outline', size: 'md' }), 'w-full gap-1.5')}
                  >
                    <Navigation className="size-3.5" aria-hidden />
                    Get directions
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {hasOnline && online && (
          <div className={cn(LUXE_CARD, 'flex items-start gap-3 p-5')}>
            <Monitor className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />
            <div className="min-w-0">
              <p className="text-fs-sm font-medium text-hero-ink">Online via {platform}</p>
              {online.joinInstructions?.trim() && <p className="mt-1 whitespace-pre-line text-fs-xs text-hero-ink-soft leading-relaxed">{online.joinInstructions}</p>}
              {online.revealAfterRegistration
                ? <p className="mt-1 text-fs-xs text-hero-ink-soft">The joining link is shared after you register.</p>
                : online.meetingUrl?.trim() && (
                  <a href={online.meetingUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-fs-xs font-medium text-action hover:underline">
                    Join link <ArrowUpRight className="size-3" aria-hidden />
                  </a>
                )}
            </div>
          </div>
        )}
      </div>
    </LuxeBlock>
  )
}

// ─── Organizer ──────────────────────────────────────────────────────────────────
export function OrganizerBlock({ organizer, supportEmail, supportPhone = '', showSocial = true }: {
  organizer: OrganizerInfo; supportEmail: string; supportPhone?: string; showSocial?: boolean
}) {
  const contact = resolveOrganizerContact({ supportEmail, organizerEmail: organizer.email, organizerPhone: organizer.phone })
  const website = organizer.website?.trim()
  // RD-CUSTOM-ORG-01 — the Organizer tab's contact phone is attendee-facing (the publish checklist
  // warns "No Contact Phone — attendees … have no way to reach you"), but it was only the THIRD
  // fallback of the Contact button behind two emails, the organizer email being required — so it
  // never appeared. It is now its own Call action, unless the Contact button already dials it or
  // "Good to know" already lists the same number as the support phone.
  const phone    = organizer.phone?.trim() || ''
  const showCall = !!phone && !contact.href.startsWith('tel:') && phone !== supportPhone.trim()
  const about   = organizer.bio?.trim() || organizer.tagline?.trim()
  // RD-CUSTOM-PUBLIC-01 — the organizer's social links (Organizer tab), honouring the
  // "Show social links" toggle. Every other template renders them; this one had dropped them.
  const s = organizer.social
  const socials = showSocial ? ([
    s?.instagram?.trim() && { label: 'Instagram', url: s.instagram.trim() },
    s?.linkedin?.trim()  && { label: 'LinkedIn',  url: s.linkedin.trim() },
    s?.twitter?.trim()   && { label: 'Twitter',   url: s.twitter.trim() },
    s?.facebook?.trim()  && { label: 'Facebook',  url: s.facebook.trim() },
    s?.youtube?.trim()   && { label: 'YouTube',   url: s.youtube.trim() },
  ].filter(Boolean) as { label: string; url: string }[]) : []
  // RD-CUSTOM-ORG-01 — "Event Hashtags" (Organizer tab, beside the social links) were saved and
  // never rendered. Shown with the social links, under the same "Show social links" toggle.
  const hashtags = showSocial
    ? [...new Set((s?.hashtags ?? []).map(h => (typeof h === 'string' ? h.trim().replace(/^#+/, '') : '')).filter(Boolean))]
    : []
  return (
    <LuxeBlock id="organizer" eyebrow="Hosted by" title={organizer.name}>
      <div className={cn(LUXE_CARD, 'flex flex-col gap-4 p-5 sm:flex-row sm:items-center')}>
        {organizer.logoUrl?.trim() && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={organizer.logoUrl} alt="" className="size-14 shrink-0 rounded-control border border-border/60 bg-card object-contain p-1" loading="lazy" />
        )}
        <p className={cn('min-w-0 flex-1', about ? BODY : 'text-fs-sm text-hero-ink-soft')}>
          {about || 'Questions about this event? Reach the organizer directly.'}
        </p>
        {(contact.href || website || showCall) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {contact.href && (
              <a href={contact.href} className={cn(marketingButton({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
                {contact.href.startsWith('tel:') ? <Phone className="size-3.5" aria-hidden /> : <Mail className="size-3.5" aria-hidden />}
                Contact
              </a>
            )}
            {showCall && (
              <a href={`tel:${phone}`} aria-label={`Call ${organizer.name} on ${phone}`} className={cn(marketingButton({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
                <Phone className="size-3.5" aria-hidden />
                Call
              </a>
            )}
            {website && (
              <a href={website} target="_blank" rel="noopener noreferrer" className={cn(marketingButton({ variant: 'outline', size: 'sm' }), 'gap-1.5')}>
                <Globe className="size-3.5" aria-hidden />
                Website
              </a>
            )}
          </div>
        )}
      </div>
      {socials.length > 0 && (
        <ul aria-label={`${organizer.name} on social media`} className="mt-3 flex flex-wrap gap-2">
          {socials.map(soc => (
            <li key={soc.label}>
              <a
                href={soc.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-pill border border-border/70 bg-card px-3 py-1 text-fs-xs font-medium text-hero-ink-soft transition-colors hover:border-border-strong hover:text-hero-ink"
              >
                {soc.label}<ArrowUpRight className="size-3" aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}
      {hashtags.length > 0 && (
        <p className="mt-3 text-fs-xs font-medium text-hero-ink-soft">
          {hashtags.map(h => `#${h}`).join('  ')}
        </p>
      )}
    </LuxeBlock>
  )
}

// ─── Gallery ────────────────────────────────────────────────────────────────────
export function GalleryBlock({ items }: { items: GalleryItem[] }) {
  const images = (items ?? []).filter(g => g?.enabled !== false && g?.url?.trim() && (!g.type || g.type === 'image' || g.type === 'poster' || g.type === 'banner' || g.type === 'drone'))
  if (images.length === 0) return null
  const shown = images.slice(0, 6)
  return (
    <LuxeBlock id="gallery" eyebrow="Gallery" title="Moments">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map(g => (
          <li key={g.id}>
            <a href={g.url} target="_blank" rel="noopener noreferrer" className="group block overflow-hidden rounded-control border border-border/60 bg-surface-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={g.thumbnail?.trim() || g.url}
                alt={g.title?.trim() || ''}
                className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                loading="lazy"
              />
            </a>
          </li>
        ))}
      </ul>
    </LuxeBlock>
  )
}

// ─── Sponsors ───────────────────────────────────────────────────────────────────
export function SponsorsBlock({ sponsors }: { sponsors: Sponsor[] }) {
  const list = (sponsors ?? [])
    .filter(s => s?.enabled !== false && (s?.name?.trim() || s?.logoUrl?.trim()))
    .sort((a, b) => (a.displayOrder ?? a.order) - (b.displayOrder ?? b.order))
  if (list.length === 0) return null
  return (
    <LuxeBlock id="sponsors" eyebrow="Partners" title="With the support of">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {list.map(s => {
          const inner = s.logoUrl?.trim()
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={s.logoUrl} alt={s.name} className="max-h-10 w-auto max-w-full object-contain" loading="lazy" />
            : <span className="text-center text-fs-xs font-medium text-hero-ink">{s.name}</span>
          return (
            <li key={s.id}>
              {s.website?.trim()
                ? <a href={s.website} target="_blank" rel="noopener noreferrer" className={cn(LUXE_CARD, 'flex h-20 items-center justify-center px-4 transition-colors hover:border-border-strong')}>{inner}</a>
                : <div className={cn(LUXE_CARD, 'flex h-20 items-center justify-center px-4')}>{inner}</div>}
            </li>
          )
        })}
      </ul>
    </LuxeBlock>
  )
}

// ─── Good to know ───────────────────────────────────────────────────────────────
export function EssentialsBlock({ language, dressCode, timezone, refundWindow, refundPolicyUrl, termsUrl, privacyPolicyUrl, faqUrl, supportEmail, supportPhone }: {
  language: string; dressCode: string; timezone?: string
  refundWindow?: RefundWindow | null; refundPolicyUrl: string
  /** RD-CUSTOM-PUBLIC-01 — the Organizer tab's policy / FAQ links; the template had dropped them. */
  termsUrl?: string; privacyPolicyUrl?: string; faqUrl?: string
  supportEmail: string; supportPhone: string
}) {
  const refunds = refundWindow && !refundWindow.useExternalPolicyUrl ? refundLines(refundWindow) : []
  const rows: { label: string; lines: string[]; href?: string }[] = [
    language?.trim()  ? { label: 'Language',   lines: [languageLabel(language.trim())] } : null,
    dressCode?.trim() ? { label: 'Dress code', lines: [dressCode.trim()] } : null,
    timezone?.trim()  ? { label: 'Timezone',   lines: [timezoneLabel(timezone.trim())] } : null,
    refunds.length    ? { label: 'Refunds',    lines: refunds } : null,
    !refunds.length && refundPolicyUrl?.trim() ? { label: 'Refunds', lines: ['Read the refund policy'], href: refundPolicyUrl.trim() } : null,
    termsUrl?.trim()         ? { label: 'Terms',   lines: ['Read the terms & conditions'], href: termsUrl.trim() } : null,
    privacyPolicyUrl?.trim() ? { label: 'Privacy', lines: ['Read the privacy policy'],     href: privacyPolicyUrl.trim() } : null,
    faqUrl?.trim()           ? { label: 'FAQ',     lines: ['Read the full FAQ'],           href: faqUrl.trim() } : null,
    supportEmail?.trim() ? { label: 'Email', lines: [supportEmail.trim()], href: `mailto:${supportEmail.trim()}` } : null,
    supportPhone?.trim() ? { label: 'Phone', lines: [supportPhone.trim()], href: `tel:${supportPhone.trim()}` } : null,
  ].filter(Boolean) as { label: string; lines: string[]; href?: string }[]
  if (rows.length === 0) return null

  return (
    <LuxeBlock id="event-info" eyebrow="Essentials" title="Good to know">
      <dl className={cn(LUXE_CARD, 'grid sm:grid-cols-2')}>
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={cn(
              'min-w-0 px-5 py-4',
              i > 0 && 'border-t border-border/60',
              i === 1 && 'sm:border-t-0',
              i % 2 === 1 && 'sm:border-l',
              // A lone final cell spans the row so the card never ends on an empty half.
              i === rows.length - 1 && rows.length % 2 === 1 && 'sm:col-span-2',
            )}
          >
            <dt className={LUXE_LABEL}>{r.label}</dt>
            {r.lines.map((line, j) => (
              <dd key={j} className="mt-1 text-fs-sm text-hero-ink">
                {r.href
                  ? <a href={r.href} target={r.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className="underline-offset-4 hover:text-action hover:underline">{line}</a>
                  : line}
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </LuxeBlock>
  )
}

// ─── FAQ ────────────────────────────────────────────────────────────────────────
export function FaqBlock({ items }: { items: FaqItem[] }) {
  const list = (items ?? [])
    .filter(f => f?.enabled !== false && f?.question?.trim() && f?.answer?.trim())
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
  if (list.length === 0) return null
  return (
    <LuxeBlock id="faq" eyebrow="Questions" title="Frequently asked">
      <div className={cn(LUXE_CARD, 'divide-y divide-border/60')}>
        {list.map(f => (
          <details key={f.id} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-fs-sm font-medium text-hero-ink [&::-webkit-details-marker]:hidden">
              {f.question}
              <Plus className="size-4 shrink-0 text-hero-accent-rule transition-transform duration-200 group-open:rotate-45" aria-hidden />
            </summary>
            <div className="-mt-1 px-5 pb-4">
              <p className={cn('whitespace-pre-line', 'text-fs-sm text-hero-ink-soft leading-relaxed')}>{f.answer}</p>
              <AttachmentChips attachments={f.attachments} links={f.links} className="mt-3" />
            </div>
          </details>
        ))}
      </div>
    </LuxeBlock>
  )
}
