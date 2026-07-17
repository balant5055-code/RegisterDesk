'use client'

import { useState, useEffect } from 'react'
import { MapPin, Globe, Navigation, Package } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type {
  PhysicalVenueConfig, OnlineVenueConfig, VenueMaps,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

export function VenueSection({ venueType, physical, online, mapsLink, venueMaps }: {
  venueType: 'physical' | 'online' | 'hybrid'
  physical?:  PhysicalVenueConfig
  online?:    OnlineVenueConfig
  mapsLink:   string
  venueMaps:  VenueMaps | null
}) {
  const [activeMap, setActiveMap] = useState<string | null>(null)

  const mapTabs = venueMaps ? [
    venueMaps.layoutImageUrl?.trim()  && { key: 'layout',  label: 'Layout',  url: venueMaps.layoutImageUrl },
    venueMaps.parkingMapUrl?.trim()   && { key: 'parking', label: 'Parking', url: venueMaps.parkingMapUrl },
    venueMaps.entryGateMapUrl?.trim() && { key: 'entry',   label: 'Entry',   url: venueMaps.entryGateMapUrl },
  ].filter(Boolean) as { key: string; label: string; url: string }[] : []

  useEffect(() => {
    if (mapTabs.length > 0 && !activeMap) setActiveMap(mapTabs[0].key)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showPhysical = (venueType === 'physical' || venueType === 'hybrid') && physical?.name?.trim()
  const showOnline   = (venueType === 'online'   || venueType === 'hybrid') && online?.platform
  if (!showPhysical && !showOnline) return null

  const facilityTags = showPhysical ? [
    venueMaps?.parkingMapUrl?.trim()  && { icon: <Package    className="size-3.5" />, text: 'Parking Map Available' },
    physical!.instructions?.trim()   && { icon: <Navigation  className="size-3.5" />, text: 'Easy Access' },
    physical!.mapsLink?.trim()        && { icon: <MapPin      className="size-3.5" />, text: 'Entry Gate' },
  ].filter(Boolean) as { icon: React.ReactNode; text: string }[] : []

  return (
    <SectionWrapper id="venue" title="Venue">
      <div className="space-y-5">
        {showPhysical && (
          <div className="flex gap-4">
            {mapTabs.length > 0 && (
              <div className="hidden sm:block w-[100px] shrink-0 overflow-hidden rounded-xl border border-border">
                {mapTabs.map(tab =>
                  activeMap === tab.key && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={tab.key}
                      src={tab.url}
                      alt={physical!.name}
                      className="h-[100px] w-full object-cover"
                      loading="lazy"
                    />
                  ),
                )}
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-foreground">{physical!.name}</p>
              <address className="mt-1 not-italic">
                <p className="text-xs text-muted-foreground">
                  {[
                    physical!.addressLine1,
                    physical!.addressLine2,
                    physical!.city,
                    physical!.state,
                    physical!.pincode,
                  ].filter(Boolean).join(', ')}
                </p>
              </address>

              <div className="mt-3 flex flex-wrap gap-2">
                {mapsLink && (
                  <a
                    href={mapsLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'gap-1.5')}
                  >
                    <MapPin className="size-3.5" aria-hidden />
                    View on Map
                  </a>
                )}
                {mapsLink && (
                  <a
                    href={mapsLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
                  >
                    <Navigation className="size-3.5" aria-hidden />
                    Get Directions
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {showPhysical && physical!.instructions?.trim() && (
          <div className="rounded-xl border-l-2 border-primary/30 bg-muted/30 px-3 py-2.5">
            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Getting There
            </p>
            <p className="text-xs leading-relaxed text-foreground">{physical!.instructions}</p>
          </div>
        )}

        {facilityTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {facilityTags.map(({ icon, text }, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 rounded-full border border-border bg-muted/30 px-3 py-1.5 text-xs font-medium text-foreground"
              >
                <span className="text-primary">{icon}</span>
                {text}
              </div>
            ))}
          </div>
        )}

        {mapTabs.length > 1 && (
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="flex gap-1 border-b border-border bg-muted/30 p-1.5">
              {mapTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveMap(tab.key)}
                  className={cn(
                    'flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                    activeMap === tab.key
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {mapTabs.map(tab =>
              activeMap === tab.key && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={tab.key}
                  src={tab.url}
                  alt={tab.label}
                  className="w-full bg-muted/20 object-contain"
                  loading="lazy"
                />
              ),
            )}
          </div>
        )}

        {showOnline && (
          <div className="flex items-start gap-3 rounded-xl bg-muted/30 px-4 py-3">
            <Globe className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {ONLINE_PLATFORM_LABELS[online!.platform] ?? online!.platform}
                {online!.platformCustomName?.trim() && ` · ${online!.platformCustomName}`}
              </p>
              {online!.revealAfterRegistration ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Meeting link will be shared after registration.
                </p>
              ) : online!.joinInstructions?.trim() ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{online!.joinInstructions}</p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </SectionWrapper>
  )
}
