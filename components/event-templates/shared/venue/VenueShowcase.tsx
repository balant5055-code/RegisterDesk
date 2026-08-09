'use client'

// VenueShowcase — the venue as a destination, not an address line.
//
// RD-ST8.0 redesign. The old layout was a details card beside a map with the venue's
// own maps dropped underneath as an afterthought, so the section answered "where is
// it?" and nothing else. It is now a two-column planning surface:
//
//   LEFT  (7 cols) — the large interactive map at a fixed aspect (no CLS), with the
//                    organiser's own venue maps (layout / parking / entry gate) as
//                    labelled cards beneath it.
//   RIGHT (5 cols) — venue identity, the full postal address, ONE action row
//                    (directions · copy · share), getting-there notes and any
//                    template-supplied highlight.
//
// Physical, online and hybrid all flow through the same component. Every block
// self-hides when its data is absent, and the section returns null when a venue has
// not been configured at all.
//
// RD-ST8.0 also fixes ST42-R01: `venueName` arrives pre-formatted and falls back to the
// literal string "Venue TBA" when no address exists. The old `hasPhysical` test treated
// that placeholder as a real name, so the section rendered a venue called "Venue TBA"
// AND fed it to Google Maps — a live map of nothing, with a Get Directions button
// pointing at a search for the phrase. Physical presence is now decided by real address
// atoms only.

import { useState } from 'react'
import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import {
  MapPin, Navigation, Car, Map as MapIcon, DoorOpen, MonitorPlay, Video,
  ExternalLink, Info, Copy, Check, Share2,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PhysicalVenueConfig, OnlineVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD, CARD_PAD_LG, reveal,
  ICON_TILE, ICON_TILE_ICON, GRID_GAP,
} from '@/components/event-templates/shared/ui/framework'

export interface VenueShowcaseProps {
  venueType:  'physical' | 'online' | 'hybrid'
  venueName?: string
  physical?:  PhysicalVenueConfig
  online?:    OnlineVenueConfig
  mapsLink?:  string
  maps?:      VenueMaps | null
  note?:      string          // optional highlight (e.g. sports start-line info)
  noteLabel?: string
  eyebrow?:   string
  title?:     string
  subtitle?:  string
}

export function VenueShowcase({
  venueType, venueName, physical, online, mapsLink, maps, note, noteLabel = 'Good to know',
  eyebrow = 'Venue', title, subtitle,
}: VenueShowcaseProps) {
  const reduce = useReducedMotion()
  const [copied, setCopied] = useState(false)

  const addr     = physical
  const lines    = [addr?.addressLine1, addr?.addressLine2].map(s => s?.trim()).filter(Boolean) as string[]
  const cityLine = [addr?.city, addr?.state, addr?.pincode].map(s => s?.trim()).filter(Boolean).join(', ')
  const country  = addr?.country?.trim() && !['india', 'in'].includes(addr.country.trim().toLowerCase())
    ? addr.country.trim() : ''

  // ST42-R01 — a venue exists only when the organiser gave us real address atoms.
  // `venueName` is a formatted label that degrades to "Venue TBA"; it can name a venue
  // but must never be the thing that proves one exists.
  const hasAddress  = !!(addr?.name?.trim() || lines.length || cityLine || mapsLink?.trim())
  const hasPhysical = venueType !== 'online' && hasAddress
  const name        = addr?.name?.trim() || (hasAddress ? venueName?.trim() ?? '' : '')

  const hasOnline = venueType !== 'physical'
    && !!(online?.meetingUrl?.trim() || online?.joinInstructions?.trim() || online?.platform)

  if (!hasPhysical && !hasOnline) return null

  // Map embed + directions built from the address (no API key, no extra request beyond
  // the one lazily-loaded iframe below).
  const query = [name, addr?.addressLine1, addr?.addressLine2, addr?.city, addr?.state, addr?.pincode, addr?.country]
    .map(s => s?.trim()).filter(Boolean).join(', ')
  const embedSrc   = query ? `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed` : ''
  const directions = mapsLink?.trim()
    || (query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '')

  const fullAddress = [name, ...lines, cityLine, country].filter(Boolean).join(', ')

  const platformLabel = online
    ? (online.platform === 'custom' && online.platformCustomName?.trim()
        ? online.platformCustomName.trim()
        : ONLINE_PLATFORM_LABELS[online.platform] ?? 'Online')
    : 'Online'

  // The organiser's own venue maps — the only facility data the schema carries.
  const mapImages = [
    { label: 'Venue Layout', url: maps?.layoutImageUrl,  icon: MapIcon },
    { label: 'Parking',      url: maps?.parkingMapUrl,   icon: Car },
    { label: 'Entry Gate',   url: maps?.entryGateMapUrl, icon: DoorOpen },
  ].filter(m => m.url?.trim()) as { label: string; url: string; icon: typeof Car }[]

  const resolvedTitle = title ?? (hasPhysical ? 'Venue Experience' : 'How to Join')

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

  const ACTION_BTN =
    'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-fs-sm font-semibold text-foreground transition-colors hover:border-foreground/25 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'

  return (
    <SectionShell id="venue" className="relative isolate overflow-hidden">
      {/* Very light brand field — continues the ST5 language, no photography. */}
      <span
        aria-hidden
        className="absolute -top-40 right-[-10%] -z-10 size-[560px] rounded-full bg-[radial-gradient(closest-side,rgb(var(--primary-rgb)/0.05),transparent)]"
      />

      <EventSectionHeader eyebrow={eyebrow} title={resolvedTitle} description={subtitle} />

      {/* ══════════ Physical ══════════ */}
      {hasPhysical && (
        <motion.div {...reveal(reduce)} className="grid gap-6 lg:grid-cols-12 lg:gap-8">

          {/* ── LEFT · map + the organiser's venue maps ── */}
          <div className="flex flex-col gap-4 lg:col-span-7">
            <div className={cn('relative aspect-[4/3] w-full overflow-hidden sm:aspect-[16/10]', CARD)}>
              {embedSrc ? (
                <iframe
                  src={embedSrc}
                  title={`Map of ${name || 'the venue'}`}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="absolute inset-0 size-full border-0"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/40 p-6 text-center">
                  <MapPin className="size-8 text-muted-foreground/40" aria-hidden />
                  <p className="text-fs-sm text-muted-foreground">Map preview unavailable for this address.</p>
                  {directions && (
                    <Link href={directions} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-fs-sm font-semibold text-primary hover:underline">
                      Open in Maps <ExternalLink className="size-3.5" aria-hidden />
                    </Link>
                  )}
                </div>
              )}
            </div>

            {mapImages.length > 0 && (
              <div className={cn('grid sm:grid-cols-3', GRID_GAP)}>
                {mapImages.map(m => (
                  <figure key={m.label} className={cn('overflow-hidden', CARD)}>
                    <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.url} alt={`${m.label} map`} loading="lazy" decoding="async" className="size-full object-cover" />
                    </div>
                    <figcaption className="flex items-center gap-1.5 px-4 py-2.5 text-fs-xs font-semibold text-foreground">
                      <m.icon className="size-3.5 text-primary" aria-hidden />{m.label}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </div>

          {/* ── RIGHT · identity · actions · getting there ── */}
          <div className="flex flex-col gap-4 lg:col-span-5">

            <div className={cn(CARD, CARD_PAD_LG)}>
              {name && <h3 className={TYPE.cardTitleLg}>{name}</h3>}

              {(lines.length > 0 || cityLine || country) && (
                <address className={cn('flex items-start gap-2.5 not-italic text-fs-sm leading-relaxed text-muted-foreground', name && 'mt-2')}>
                  <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>
                    {lines.map((l, i) => <span key={i} className="block">{l}</span>)}
                    {cityLine && <span className="block">{cityLine}</span>}
                    {country && <span className="block">{country}</span>}
                  </span>
                </address>
              )}

              {/* ONE action area — directions, copy, share. No duplicates. */}
              <div className="mt-5 flex flex-col gap-2.5">
                {directions && (
                  <Link
                    href={directions} target="_blank" rel="noopener noreferrer"
                    className={cn(ACTION_BTN, 'border-transparent bg-[image:var(--primary-gradient)] text-white shadow-sm hover:bg-[image:var(--primary-gradient)] hover:brightness-105')}
                  >
                    <Navigation className="size-4" aria-hidden />Get Directions
                  </Link>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  <button type="button" onClick={onCopy} disabled={!fullAddress} className={cn(ACTION_BTN, !fullAddress && 'opacity-50')}>
                    {copied ? <Check className="size-4 text-primary" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                    {copied ? 'Copied' : 'Copy Address'}
                  </button>
                  <button type="button" onClick={onShare} className={ACTION_BTN}>
                    <Share2 className="size-4" aria-hidden />Share
                  </button>
                </div>
              </div>
            </div>

            {addr?.instructions?.trim() && (
              <div className={cn(CARD, CARD_PAD)}>
                <p className={cn('flex items-center gap-1.5', TYPE.label)}>
                  <Navigation className="size-3.5 text-primary" aria-hidden />Getting there
                </p>
                <p className="mt-1.5 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">
                  {addr.instructions}
                </p>
              </div>
            )}

            {note?.trim() && (
              <div className={cn(CARD, CARD_PAD)}>
                <p className={cn('flex items-center gap-1.5', TYPE.label)}>
                  <Info className="size-3.5 text-primary" aria-hidden />{noteLabel}
                </p>
                <p className="mt-1.5 whitespace-pre-line text-fs-sm leading-relaxed text-foreground/80">{note}</p>
              </div>
            )}
          </div>
        </motion.div>
      )}

      {/* ══════════ Online (also appended for hybrid) ══════════ */}
      {hasOnline && (
        <motion.div {...reveal(reduce)} className={cn(CARD, CARD_PAD_LG, hasPhysical && 'mt-6')}>
          <div className="flex items-start gap-3">
            <span className={ICON_TILE}>
              <MonitorPlay className={ICON_TILE_ICON} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className={TYPE.cardTitle}>
                {hasPhysical ? 'Also streaming online' : 'Online Event'}
                <span className="ml-2 text-fs-sm font-semibold text-muted-foreground">via {platformLabel}</span>
              </h3>

              {online?.joinInstructions?.trim() && (
                <p className="mt-1.5 whitespace-pre-line text-fs-sm leading-relaxed text-muted-foreground">
                  {online.joinInstructions}
                </p>
              )}

              {online?.revealAfterRegistration ? (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-fs-xs font-medium text-muted-foreground">
                  <Info className="size-3.5" aria-hidden />Join details are shared after registration.
                </p>
              ) : online?.meetingUrl?.trim() ? (
                <Link href={online.meetingUrl} target="_blank" rel="noopener noreferrer" className={cn('mt-4', ACTION_BTN)}>
                  <Video className="size-4" aria-hidden />Join Event <ExternalLink className="size-3.5" aria-hidden />
                </Link>
              ) : null}
            </div>
          </div>
        </motion.div>
      )}
    </SectionShell>
  )
}
