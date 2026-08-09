'use client'

// RD-RACEOPS-01 · Race Operations — module hub.
//
// Why this page exists (Phase 0 finding): the collapsed sidebar renders each nav
// group as a single icon linking to `group.href` (components/dashboard/Sidebar.tsx:394).
// A group whose href has no page would 404 for anyone using the 72px sidebar. Shipping
// a real hub here fixes that at the source — and it means app/(dashboard)/layout.tsx
// needs no edit, since `race-operations` resolves to a live page for breadcrumbs too.
//
// Pure navigation. No data fetch, no writes.

import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { ArrowRight, Award, Camera, History, Send } from 'lucide-react'
import { Card, StatusChip } from '@/components/ui'
import { ROUTES } from '@/config/navigation'

interface HubEntry {
  icon:        LucideIcon
  title:       string
  description: string
  href:        string
  cta:         string
  /** null = live; otherwise the sprint that delivers it. */
  planned:     string | null
  /** True for destinations owned by another module. */
  external?:   boolean
}

const ENTRIES: HubEntry[] = [
  {
    icon:        Send,
    title:       'Publish Results',
    description: 'Select an event and race, then upload, validate and publish finishing results.',
    href:        ROUTES.RACE_OPS_PUBLISH_RESULTS,
    cta:         'Open',
    planned:     null,
  },
  {
    // RD-MEDIA-04: the Race Operations "Photos" placeholder is gone. Photo hosting is a
    // PLATFORM capability that shipped as Media Studio, so this links there rather than
    // duplicating a second photo surface inside Race Operations.
    icon:        Camera,
    title:       'Photos',
    description: 'Bulk photo import, galleries and albums are handled by Media Studio, a platform module shared by every event type.',
    href:        ROUTES.MEDIA_STUDIO,
    cta:         'Open Media Studio',
    planned:     null,
    external:    true,
  },
  {
    icon:        Award,
    title:       'Certificates',
    description: 'Issued by the existing certificate module, which already works independently of results.',
    href:        ROUTES.DASHBOARD_CERTIFICATES,
    cta:         'Open Certificates',
    planned:     null,
    external:    true,
  },
  {
    icon:        History,
    title:       'History',
    description: 'Import history, publish logs and rollback information for every race.',
    href:        ROUTES.RACE_OPS_HISTORY,
    cta:         'Open',
    planned:     'Sprint 8',
  },
]

export function RaceOpsOverview() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {ENTRIES.map(({ icon: Icon, title, description, href, cta, planned, external }) => (
        <li key={title}>
          <Card hover className="h-full">
            <div className="flex h-full flex-col gap-3">
              <div className="flex items-start gap-3">
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted"
                  aria-hidden
                >
                  <Icon className="size-[18px] text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-fs-md font-semibold text-foreground">{title}</h2>
                    {planned
                      ? <StatusChip tone="neutral">Planned · {planned}</StatusChip>
                      : external
                        ? <StatusChip tone="info">Existing module</StatusChip>
                        : null}
                  </div>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                </div>
              </div>

              <Link
                href={href}
                className="mt-auto inline-flex items-center gap-1.5 self-start text-[13.5px] font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {cta}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  )
}
