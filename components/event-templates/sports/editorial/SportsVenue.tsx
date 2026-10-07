'use client'

// ─── SportsVenue — the start line as a place ─────────────────────────────────
//
// SPORTS-ONLY. Same behaviour as the shared VenueShowcase — the same lazily embedded
// Google map built from the address atoms (no API key, no extra request), the same
// directions target, the same copy-address and share actions, the same organiser venue
// maps — but composed instead of boxed: the map is the object, and the address sits
// beside it as type on hairlines rather than inside a bordered panel with three
// full-width buttons under it.
//
//                ──────────  VENUE  ──────────
//                     Venue Experience
//   ┌────────────────────────────────────────────────────────────────────┐
//   │                      the map, one wide plate                       │
//   └────────────────────────────────────────────────────────────────────┘
//                    Nallammal Temple, Mangalam
//                    Tiruppur, Tamilnadu, 641663
//           Get Directions · Copy Address · Share
//
// Physical, online and hybrid all flow through this file. A venue exists only when the
// organiser gave real address atoms — `venueName` degrades to the literal "Venue TBA",
// so it can name a venue but never prove one (the ST42-R01 rule, preserved).

import { useState } from 'react'
import { Navigation, Copy, Check, Share2, Video, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PhysicalVenueConfig, OnlineVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { BODY, FIELD, QUIET_ACTION, SectionHead, SportsSection, splitVenueName, RAIL_PANEL, RailHead, ITEM, SPORTS_SCROLL_MT, OUTLINE_ACTION } from './primitives'

/** The panel's one solid control — ink, the control radius, the full width. */
const VENUE_PRIMARY =
  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-hero-ink px-4 text-fs-sm font-semibold text-ink-on-media ' +
  'transition-colors duration-200 hover:bg-action focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2'

export interface SportsVenueProps {
  venueType:  'physical' | 'online' | 'hybrid'
  venueName?: string
  physical?:  PhysicalVenueConfig
  online?:    OnlineVenueConfig
  mapsLink?:  string
  maps?:      VenueMaps | null
  /** Optional highlight (the sports start-line note). */
  note?:      string
  noteLabel?: string
  eyebrow?:   string
  title?:     string
  subtitle?:  string
  /** 'band' — the full-width section (default). 'rail' — the compact sticky-rail panel. */
  layout?:    'band' | 'rail'
}

export function SportsVenue({
  venueType, venueName, physical, online, mapsLink, maps, note, noteLabel = 'Start line',
  eyebrow = 'Venue', title, subtitle, layout = 'band',
}: SportsVenueProps) {
  const [copied, setCopied] = useState(false)

  const addr     = physical
  const lines    = [addr?.addressLine1, addr?.addressLine2].map(s => s?.trim()).filter(Boolean) as string[]
  const cityLine = [addr?.city, addr?.state, addr?.pincode].map(s => s?.trim()).filter(Boolean).join(', ')
  const country  = addr?.country?.trim() && !['india', 'in'].includes(addr.country.trim().toLowerCase())
    ? addr.country.trim() : ''

  const hasAddress  = !!(addr?.name?.trim() || lines.length || cityLine || mapsLink?.trim())
  const hasPhysical = venueType !== 'online' && hasAddress
  const rawName     = addr?.name?.trim() || (hasAddress ? venueName?.trim() ?? '' : '')
  // The organiser may have pasted a maps URL into the NAME; split it so the heading
  // reads as a name and the link survives as an action (nothing is dropped).
  const { name, url: nameUrl } = splitVenueName(rawName)

  const hasOnline = venueType !== 'physical'
    && !!(online?.meetingUrl?.trim() || online?.joinInstructions?.trim() || online?.platform)

  if (!hasPhysical && !hasOnline) return null

  const query = [name, addr?.addressLine1, addr?.addressLine2, addr?.city, addr?.state, addr?.pincode, addr?.country]
    .map(s => s?.trim()).filter(Boolean).join(', ')
  const embedSrc   = query ? `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed` : ''
  const directions = mapsLink?.trim() || nameUrl
    || (query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '')
  const fullAddress = [name, ...lines, cityLine, country].filter(Boolean).join(', ')

  const platformLabel = online
    ? (online.platform === 'custom' && online.platformCustomName?.trim()
        ? online.platformCustomName.trim()
        : ONLINE_PLATFORM_LABELS[online.platform] ?? 'Online')
    : 'Online'

  const mapImages = [
    { label: 'Venue layout', url: maps?.layoutImageUrl },
    { label: 'Parking',      url: maps?.parkingMapUrl },
    { label: 'Entry gate',   url: maps?.entryGateMapUrl },
  ].filter(m => m.url?.trim()) as { label: string; url: string }[]

  const onCopy = async () => {
    if (typeof window === 'undefined' || !fullAddress) return
    try {
      await navigator.clipboard.writeText(fullAddress)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* ignored */ }
  }

  const onShare = async () => {
    if (typeof window === 'undefined') return
    const text = [fullAddress, directions].filter(Boolean).join(' — ')
    try {
      if (navigator.share) { await navigator.share({ title: name || 'Venue', text }); return }
      await navigator.clipboard.writeText(text)
      setCopied(true); setTimeout(() => setCopied(false), 1800)
    } catch { /* dismissed */ }
  }

  if (layout === 'rail') {
    return (
      <section id="venue" className={cn(SPORTS_SCROLL_MT, RAIL_PANEL)}>
        <RailHead eyebrow={eyebrow} title={title ?? (hasPhysical ? 'Venue Experience' : 'How to Join')} />

        {embedSrc && (
          <div className="relative mt-4 aspect-[16/9] w-full overflow-hidden rounded-surface border border-border/60 bg-muted/30 lg:aspect-[21/9]">
            <iframe
              src={embedSrc}
              title={`Map of ${name || 'the venue'}`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="absolute inset-0 size-full border-0"
            />
          </div>
        )}

        {hasPhysical && (
          <div className="mt-4 text-center sm:text-left">
            <p className={cn('text-balance break-words', ITEM)}>{name}</p>
            <address className={cn('mt-1.5 not-italic', BODY)}>
              {lines.map(l => <span key={l} className="block break-words">{l}</span>)}
              {cityLine && <span className="block">{cityLine}</span>}
              {country && <span className="block">{country}</span>}
            </address>
            {/* The actions (2026-09-25, owner): Get Directions is the one SOLID control — the
                reason most people open this panel — full width; Copy Address and Share sit
                beneath it as an equal pair of outlined controls. */}
            <div className="mt-4 grid gap-2">
              {directions && (
                <a href={directions} target="_blank" rel="noopener noreferrer" className={VENUE_PRIMARY}>
                  <Navigation className="size-4" aria-hidden />Get Directions
                </a>
              )}
              <div className={cn('grid gap-2', fullAddress ? 'grid-cols-2' : 'grid-cols-1')}>
                {fullAddress && (
                  <button type="button" onClick={onCopy} className={cn(OUTLINE_ACTION, 'justify-center', copied && 'border-success/50 text-success')}>
                    {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4 text-hero-accent-rule" aria-hidden />}
                    {copied ? 'Copied' : 'Copy Address'}
                  </button>
                )}
                <button type="button" onClick={onShare} className={cn(OUTLINE_ACTION, 'justify-center')}>
                  <Share2 className="size-4 text-hero-accent-rule" aria-hidden />Share
                </button>
              </div>
            </div>
            {addr?.instructions?.trim() && (
              <div className="mt-4 border-t border-border/60 pt-3">
                <p className={FIELD}>Getting there</p>
                <p className="mt-1 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">{addr.instructions.trim()}</p>
              </div>
            )}
            {note?.trim() && (
              <div className="mt-4 border-t border-border/60 pt-3">
                <p className={FIELD}>{noteLabel}</p>
                <p className="mt-1 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">{note.trim()}</p>
              </div>
            )}
          </div>
        )}

        {hasOnline && (
          <div className="mt-4 border-t border-border/60 pt-3">
            <p className={FIELD}>Online</p>
            <p className="mt-1 flex items-center gap-2 text-fs-sm font-semibold text-foreground">
              <Video className="size-4 text-action" aria-hidden />{platformLabel}
            </p>
            {online?.revealAfterRegistration ? (
              <p className="mt-1 text-fs-sm text-muted-foreground">Joining link shared after registration</p>
            ) : (
              <>
                {online?.joinInstructions?.trim() && <p className="mt-1 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">{online.joinInstructions.trim()}</p>}
                {online?.meetingUrl?.trim() && (
                  <a href={online.meetingUrl.trim()} target="_blank" rel="noopener noreferrer" className={cn(QUIET_ACTION, 'mt-1')}>
                    Join link<ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </>
            )}
          </div>
        )}
      </section>
    )
  }

  return (
    <SportsSection id="venue">
      <div>
        <SectionHead eyebrow={eyebrow} title={title ?? (hasPhysical ? 'Venue Experience' : 'How to Join')} lead={subtitle} />

        <div className={cn('mt-9', embedSrc && 'lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-x-12')}>

        {/* ── The wide column: the map ───────────────────────────────────────── */}
        {embedSrc && (
          <div className="min-w-0">
            <div className="relative aspect-[4/3] w-full overflow-hidden rounded-panel border border-border/60 bg-muted/30 sm:aspect-[16/10]">
              <iframe
                src={embedSrc}
                title={`Map of ${name || 'the venue'}`}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                className="absolute inset-0 size-full border-0"
              />
            </div>

            {mapImages.length > 0 && (
              <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                {mapImages.map(m => (
                  <li key={m.label}>
                    <a href={m.url} target="_blank" rel="noopener noreferrer" className="group block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.url} alt={m.label} loading="lazy" decoding="async" className="block h-auto w-full rounded-surface object-contain" />
                      <span className={cn(FIELD, 'mt-2 block text-center group-hover:text-action')}>{m.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── (rail follows) ─────────────────────────────────────── */}
        <div className={cn('min-w-0', embedSrc && 'mt-8 lg:mt-0 lg:border-l lg:border-border/60 lg:pl-12')}>
          {hasPhysical && (
            <div>
              <p className="text-balance break-words text-fs-lg font-semibold leading-snug text-hero-ink">{name}</p>
              <address className={cn('mt-2.5 not-italic', BODY)}>
                {lines.map(l => <span key={l} className="block break-words">{l}</span>)}
                {cityLine && <span className="block">{cityLine}</span>}
                {country && <span className="block">{country}</span>}
              </address>

              <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-2">
                {directions && (
                  <a href={directions} target="_blank" rel="noopener noreferrer" className={QUIET_ACTION}>
                    <Navigation className="size-4" aria-hidden />Get Directions
                  </a>
                )}
                {fullAddress && (
                  <button type="button" onClick={onCopy} className={QUIET_ACTION}>
                    {copied ? <Check className="size-4 text-action" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                    {copied ? 'Copied' : 'Copy Address'}
                  </button>
                )}
                <button type="button" onClick={onShare} className={QUIET_ACTION}>
                  <Share2 className="size-4" aria-hidden />Share
                </button>
              </div>

              {addr?.instructions?.trim() && (
                <div className="mt-6 border-t border-border/60 pt-4">
                  <p className={FIELD}>Getting there</p>
                  <p className={cn('mt-1 whitespace-pre-line', BODY)}>{addr.instructions.trim()}</p>
                </div>
              )}

              {note?.trim() && (
                <div className="mt-6 border-t border-border/60 pt-4">
                  <p className={FIELD}>{noteLabel}</p>
                  <p className={cn('mt-1 whitespace-pre-line', BODY)}>{note.trim()}</p>
                </div>
              )}
            </div>
          )}

          {hasOnline && (
            <div className={cn('border-t border-border/60 pt-4', hasPhysical ? 'mt-6' : '')}>
              <p className={FIELD}>Online</p>
              <p className="mt-1 flex items-center gap-2 text-fs-md font-semibold text-foreground">
                <Video className="size-4 text-action" aria-hidden />{platformLabel}
              </p>
              {online?.revealAfterRegistration ? (
                <p className={cn('mt-1', BODY)}>Joining link shared after registration</p>
              ) : (
                <>
                  {online?.joinInstructions?.trim() && <p className={cn('mt-1 whitespace-pre-line', BODY)}>{online.joinInstructions.trim()}</p>}
                  {online?.meetingUrl?.trim() && (
                    <a href={online.meetingUrl.trim()} target="_blank" rel="noopener noreferrer" className={cn(QUIET_ACTION, 'mt-2')}>
                      Join link<ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    </SportsSection>
  )
}
