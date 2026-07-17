'use client'

// VenueShowcase — the premium, reusable "where it happens" section.
//
// 100% data-driven: physical, online and hybrid venues all flow through the same
// component; every field renders only when the organiser provides it, and if there
// is no venue data at all the whole section returns null. Shared by every template
// (Sports wires it first). Distinct from the legacy shared/venue/VenueSection, which
// stays untouched for the templates that still use it.

import Link from 'next/link'
import { motion, useReducedMotion } from 'framer-motion'
import { MapPin, Navigation, Car, Map as MapIcon, DoorOpen, MonitorPlay, Video, ExternalLink, Info } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { PhysicalVenueConfig, OnlineVenueConfig, VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { SectionShell, SectionHeader, CARD, reveal } from '@/components/event-templates/shared/ui/framework'

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
}

export function VenueShowcase({
  venueType, venueName, physical, online, mapsLink, maps, note, noteLabel = 'Good to know',
  eyebrow = 'Venue', title,
}: VenueShowcaseProps) {
  const reduce = useReducedMotion()

  const addr = physical
  const name = addr?.name?.trim() || venueName?.trim() || ''
  const lines = [addr?.addressLine1, addr?.addressLine2].map(s => s?.trim()).filter(Boolean) as string[]
  const cityLine = [addr?.city, addr?.state, addr?.pincode].map(s => s?.trim()).filter(Boolean).join(', ')
  const country = addr?.country?.trim() && !['india', 'in'].includes(addr.country.trim().toLowerCase()) ? addr.country.trim() : ''

  const hasPhysical = venueType !== 'online'
    && !!(name || lines.length || cityLine || mapsLink?.trim())
  const hasOnline = venueType !== 'physical'
    && !!(online?.meetingUrl?.trim() || online?.joinInstructions?.trim() || online?.platform)

  if (!hasPhysical && !hasOnline) return null

  // Map embed + directions built from the address (no API key needed).
  const query = [name, addr?.addressLine1, addr?.addressLine2, addr?.city, addr?.state, addr?.pincode, addr?.country]
    .map(s => s?.trim()).filter(Boolean).join(', ')
  const embedSrc = query ? `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed` : ''
  const directions = mapsLink?.trim()
    || (query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : '')

  const platformLabel = online
    ? (online.platform === 'custom' && online.platformCustomName?.trim()
        ? online.platformCustomName.trim()
        : ONLINE_PLATFORM_LABELS[online.platform] ?? 'Online')
    : 'Online'

  const mapImages = [
    { label: 'Venue Layout', url: maps?.layoutImageUrl, icon: MapIcon },
    { label: 'Parking',      url: maps?.parkingMapUrl,  icon: Car },
    { label: 'Entry Gate',   url: maps?.entryGateMapUrl, icon: DoorOpen },
  ].filter(m => m.url?.trim()) as { label: string; url: string; icon: typeof Car }[]

  const resolvedTitle = title ?? (hasPhysical ? 'Where It Happens' : 'How to Join')

  return (
    <SectionShell id="venue" maxW="6xl">

        <SectionHeader eyebrow={eyebrow} title={resolvedTitle} />

        {/* ── Physical ── */}
        {hasPhysical && (
          <motion.div {...reveal(reduce)} className="grid items-stretch gap-6 lg:grid-cols-[1fr_1.1fr]">
            {/* details */}
            <div className={cn('flex flex-col p-6', CARD)}>
              {name && <h3 className="text-[19px] font-bold leading-tight text-foreground">{name}</h3>}

              {(lines.length > 0 || cityLine || country) && (
                <address className="mt-2 flex items-start gap-2.5 not-italic text-[14px] leading-relaxed text-muted-foreground">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-primary/70" aria-hidden />
                  <span>
                    {lines.map((l, i) => <span key={i} className="block">{l}</span>)}
                    {cityLine && <span className="block">{cityLine}</span>}
                    {country && <span className="block">{country}</span>}
                  </span>
                </address>
              )}

              {note?.trim() && (
                <div className="mt-4 rounded-xl bg-muted/50 px-3.5 py-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Info className="size-3.5" aria-hidden />{noteLabel}
                  </p>
                  <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-foreground/80">{note}</p>
                </div>
              )}

              {addr?.instructions?.trim() && (
                <div className="mt-4">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Navigation className="size-3.5" aria-hidden />Getting there
                  </p>
                  <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-muted-foreground">{addr.instructions}</p>
                </div>
              )}

              {directions && (
                <Link
                  href={directions} target="_blank" rel="noopener noreferrer"
                  className="mt-5 inline-flex w-fit items-center gap-2 rounded-full px-5 py-2.5 text-[13.5px] font-bold text-white shadow-sm transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                  style={{ backgroundImage: 'var(--primary-gradient)' }}
                >
                  <Navigation className="size-4" aria-hidden />Get Directions
                </Link>
              )}
            </div>

            {/* map */}
            <div className="relative min-h-[280px] overflow-hidden rounded-2xl border border-border/50 bg-muted shadow-sm lg:min-h-full">
              {embedSrc ? (
                <iframe
                  src={embedSrc}
                  title={`Map of ${name || 'the venue'}`}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="absolute inset-0 h-full w-full border-0"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <MapPin className="size-8 text-muted-foreground/40" aria-hidden />
                  {directions && (
                    <Link href={directions} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-primary hover:underline">
                      Open in Maps <ExternalLink className="size-3.5" aria-hidden />
                    </Link>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* ── Venue map images ── */}
        {mapImages.length > 0 && (
          <motion.div {...reveal(reduce)} className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {mapImages.map(m => (
              <figure key={m.label} className="overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm">
                <div className="aspect-[4/3] w-full overflow-hidden bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt={m.label} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                </div>
                <figcaption className="flex items-center gap-1.5 px-4 py-2.5 text-[12.5px] font-semibold text-foreground">
                  <m.icon className="size-3.5 text-primary/70" aria-hidden />{m.label}
                </figcaption>
              </figure>
            ))}
          </motion.div>
        )}

        {/* ── Online (also appended for hybrid) ── */}
        {hasOnline && (
          <motion.div {...reveal(reduce)} className={cn('rounded-2xl border border-border/50 bg-card p-6 shadow-sm', hasPhysical && 'mt-6')}>
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <MonitorPlay className="size-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[17px] font-bold text-foreground">
                  {hasPhysical ? 'Also streaming online' : 'Online Event'}
                  <span className="ml-2 text-[13px] font-semibold text-muted-foreground">via {platformLabel}</span>
                </h3>

                {online?.joinInstructions?.trim() && (
                  <p className="mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed text-muted-foreground">{online.joinInstructions}</p>
                )}

                {online?.revealAfterRegistration ? (
                  <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground">
                    <Info className="size-3.5" aria-hidden />Join details are shared after registration.
                  </p>
                ) : online?.meetingUrl?.trim() ? (
                  <Link
                    href={online.meetingUrl} target="_blank" rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-2 rounded-full border border-border/80 bg-card px-5 py-2.5 text-[13.5px] font-semibold text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  >
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
