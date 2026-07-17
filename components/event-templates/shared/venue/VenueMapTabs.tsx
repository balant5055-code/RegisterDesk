'use client'

import { useState, useEffect } from 'react'
import type { VenueMaps } from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'

export function VenueMapTabs({ venueMaps, venueName }: {
  venueMaps: VenueMaps | null
  venueName?: string
}) {
  const tabs = venueMaps ? [
    venueMaps.layoutImageUrl?.trim()  && { key: 'layout',  label: 'Layout',  url: venueMaps.layoutImageUrl },
    venueMaps.parkingMapUrl?.trim()   && { key: 'parking', label: 'Parking', url: venueMaps.parkingMapUrl },
    venueMaps.entryGateMapUrl?.trim() && { key: 'entry',   label: 'Entry',   url: venueMaps.entryGateMapUrl },
  ].filter(Boolean) as { key: string; label: string; url: string }[] : []

  const [active, setActive] = useState<string | null>(null)
  useEffect(() => { if (tabs.length > 0 && !active) setActive(tabs[0].key) }, [])

  if (tabs.length === 0) return null

  return (
    <div className="mt-5 overflow-hidden rounded-xl border border-border">
      {tabs.length > 1 && (
        <div className="flex gap-1 border-b border-border bg-muted/30 p-1.5">
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              className={cn(
                'flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors',
                active === tab.key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}
      {tabs.map(tab =>
        active === tab.key && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={tab.key}
            src={tab.url}
            alt={`${tab.label} map${venueName ? ` – ${venueName}` : ''}`}
            className="w-full bg-muted/20 object-contain"
            loading="lazy"
          />
        ),
      )}
    </div>
  )
}
