'use client'

// RD-MEDIA-UX-01 · Compact compression selector.
//
// Replaces five cards, each carrying a title, a five-star rating and a full paragraph, laid
// out in a three-column grid — about 264px to make one choice, and the stars read as a user
// rating of the profile rather than a quality tier.
//
// Collapsed it is one row. Expanded it is a segmented control plus ONE description: the
// selected profile's. The other four descriptions were never being read at the moment of
// choosing; they were being skimmed past.
//
// PRESENTATION ONLY. `COMPRESSION_PROFILES` and `profileId` are untouched; this renders the
// same list and calls the same setter.

import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { StatusChip } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import type { CompressionProfile } from '@/features/media-studio/utils/compressionProfiles'

export interface CompressionSelectorProps {
  profiles: readonly CompressionProfile[]
  selected: CompressionProfile
  onSelect: (id: string) => void
}

export function CompressionSelector({ profiles, selected, onSelect }: CompressionSelectorProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-2">
      {/* Collapsed summary — always present, so expanding changes nothing above it. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fs-base font-semibold text-foreground">{selected.name}</span>
        {selected.recommended && <StatusChip tone="primary">Recommended</StatusChip>}
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className={cn(
            'ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5',
            'text-fs-sm font-semibold text-primary transition-opacity hover:opacity-80',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          )}
        >
          {open ? 'Done' : 'Change'}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </div>

      {open && (
        // A segmented control, not cards. `flex-wrap` keeps it to one row on desktop and
        // wraps gracefully on mobile without horizontal overflow.
        <div
          role="group"
          aria-label="Compression profile"
          className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1"
        >
          {profiles.map(p => {
            const active = p.id === selected.id
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(p.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-fs-sm transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active
                    ? 'bg-card font-semibold text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {active && <Check className="size-3.5 text-primary" aria-hidden />}
                {p.name}
              </button>
            )
          })}
        </div>
      )}

      {/* ONE description — the selected profile's. */}
      <p className="text-fs-sm leading-relaxed text-muted-foreground">{selected.description}</p>
    </div>
  )
}
