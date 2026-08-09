'use client'

// RD-MEDIA-01 · Media Studio hub grid.
//
// A CLIENT component that owns its own entries, icons included.
//
// This is not incidental: the icons are React components (functions), and a server component
// cannot pass a function as a prop to a client component — Next.js refuses to serialize it and
// the build fails at prerender. Defining the list here keeps the boundary clean, and matches
// how RaceOpsOverview already does it.

import { useCallback, useEffect, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Camera, Coins, HardDrive, Images, Layers, Settings2, Sparkles, Upload, Wand2, Wrench,
} from 'lucide-react'
import { StudioNavCard } from './MediaStudioShell'
import { ROUTES } from '@/config/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import { useMediaStudio } from '@/features/media-studio/context/MediaStudioContext'
import { HUB_STATUS } from '@/features/photo-branding/utils/brandingCopy'
import type { BrandingResponse } from '@/app/api/organizer/media-studio/branding/route'

interface HubEntry {
  icon:        LucideIcon
  title:       string
  description: string
  href:        string
  /** Resolved at render for entries whose state matters before you open them. */
  key?:        'branding'
}

const ENTRIES: HubEntry[] = [
  {
    icon: Upload, title: 'Import Media', href: ROUTES.MEDIA_STUDIO_IMPORT,
    description: 'Bulk upload photos by folder or selection, with automatic compression.',
  },
  {
    icon: Sparkles, title: 'Photo Branding', href: ROUTES.MEDIA_STUDIO_BRANDING, key: 'branding',
    description: 'Set up your event overlay. Branding is applied during import, so decide before you import.',
  },
  {
    icon: Images, title: 'Galleries', href: ROUTES.MEDIA_STUDIO_GALLERIES,
    description: 'Organise photos by race, location or moment — Finish Line, 21 KM, Expo.',
  },
  {
    icon: Layers, title: 'Albums', href: ROUTES.MEDIA_STUDIO_ALBUMS,
    description: 'Subdivide a gallery by camera or vantage point.',
  },
  {
    icon: Wand2, title: 'Processing Jobs', href: ROUTES.MEDIA_STUDIO_PROCESSING,
    description: 'Watch compression and rendition generation for the current import.',
  },
  {
    icon: HardDrive, title: 'Storage Usage', href: ROUTES.MEDIA_STUDIO_STORAGE,
    description: 'Storage used, photo count, compression savings and average file size.',
  },
  {
    // MC-08.1 · Before this, Credits was reachable ONLY from the Import page's low-balance
    // link — an organizer with a healthy balance had no way to find it at all.
    icon: Coins, title: 'Credits', href: ROUTES.MEDIA_STUDIO_CREDITS,
    description: 'Balance, purchases, transaction history and upload usage.',
  },
  {
    icon: Settings2, title: 'Settings', href: ROUTES.MEDIA_STUDIO_SETTINGS,
    description: 'Default compression profile, renditions to generate, and visibility.',
  },
  {
    icon: Wrench, title: 'Maintenance', href: ROUTES.MEDIA_STUDIO_MAINTENANCE,
    description: 'Reclaim abandoned uploads, retry failed deletions and clear finished jobs.',
  },
]

export function MediaStudioHub() {
  const { getToken } = useAuth()
  const { event }    = useMediaStudio()
  const [branding, setBranding] = useState<BrandingResponse | null>(null)

  const load = useCallback(async (eventId: string): Promise<BrandingResponse | null> => {
    const token = await getToken()
    if (!token) return null
    const res = await fetch(
      `/api/organizer/media-studio/branding?eventId=${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
    )
    if (!res.ok) return null
    return await res.json() as BrandingResponse
  }, [getToken])

  // The hub shows STATUS, not just links — "Not Configured" on this card is the earliest
  // point an organizer can notice branding needs deciding.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (!event) { if (!cancelled) setBranding(null); return }
      try {
        const data = await load(event.eventId)
        if (!cancelled) setBranding(data)
      } catch {
        // A status chip is a nicety; the card still links where it should.
        if (!cancelled) setBranding(null)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [event, load])

  const badgeFor = (entry: HubEntry): string | undefined => {
    if (entry.key !== 'branding' || !event || !branding) return undefined
    return HUB_STATUS[branding.workflow.state]
  }

  return (
    <div className="space-y-4">
      <ul className="grid gap-3 sm:grid-cols-2">
        {ENTRIES.map(e => (
          <li key={e.title}>
            <StudioNavCard
              icon={e.icon}
              title={e.title}
              description={e.description}
              href={e.href}
              badge={badgeFor(e)}
            />
          </li>
        ))}
      </ul>
      <p className="text-fs-sm text-muted-foreground">
        <Camera className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
        Photos are stored in object storage through the platform storage layer; only metadata
        is kept in the database.
      </p>
    </div>
  )
}
